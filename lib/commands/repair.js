// repair — the supported remedy for a corrupt board.
//
// For as long as a malformed items.jsonl produced "Repair it by hand or
// restore it from git", the tool's worst failure had exactly one remedy: the
// one action every other surface forbids. `gw brief` ends with "Never edit
// .gatewright/ by hand", the agents block forbids it outright, and the digest
// exists to catch whoever does it anyway. A recovery path the tool itself
// polices is not a recovery path.
//
// The rules repair obeys:
// - it validates every line of items.jsonl and events.jsonl and reports each
//   bad line with its number and what is wrong with it;
// - bad lines move to .gatewright/quarantine.jsonl rather than being deleted
//   -- never destroy a user's data to fix their file;
// - the digest is re-baselined afterwards, because a rewrite that skips the
//   re-baseline makes the tool accuse the user of tampering after its own
//   repair (this exact regression shipped once already -- see the digest
//   comment in store.js);
// - it is a DRY RUN by default. --write is the deliberate step.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';

export const spec = {
  summary: 'quarantine corrupt lines from the board files so it loads again (dry run by default)',
  flags: { write: { type: 'boolean' } },
  positionals: [],
};

// items.jsonl and events.jsonl are the two line-oriented files; stages.json
// and config.json are read whole as JSON, so their failure mode is one bad
// file, not one bad line, and git history is the remedy for those.
const AUDITED = ['items', 'events'];

function auditLine(file, line, index) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return `not valid JSON (${error.message})`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'is not a JSON object';
  if (file === 'items' && typeof parsed.id !== 'string') return 'is an item without an "id"';
  if (file === 'events' && typeof parsed.type !== 'string') return 'is an event without a "type"';
  return null;
}

// Physical line numbers, blank lines included, so a number printed here is
// the number an editor shows — the number a person has to act on.
function audit(store) {
  const findings = [];
  for (const file of AUDITED) {
    const path = store.paths[file];
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (raw === '') continue;
    raw.split('\n').forEach((line, index) => {
      if (line.trim() === '') return;
      const problem = auditLine(file, line, index);
      if (problem) findings.push({ file, line: index + 1, problem, raw: line });
    });
  }
  return findings;
}

export function run(ctx) {
  const { store, stdout } = ctx;
  const report = (findings) => {
    for (const finding of findings) stdout.write(`${finding.file}.jsonl: line ${finding.line} ${finding.problem}\n`);
  };

  const findings = audit(store);
  if (!findings.length) {
    stdout.write('Board files are clean. Nothing to repair.\n');
    return 0;
  }
  if (!ctx.flags.write) {
    report(findings);
    stdout.write(`Found ${findings.length} bad line(s). Dry run — nothing changed.\nRun again with --write to quarantine them in .gatewright/quarantine.jsonl and repair the board.\n`);
    return 1;
  }

  return store.withLock(() => {
    // Re-audit under the lock: a concurrent gw write may have fixed or changed
    // the file between the report above and now.
    const current = audit(store);
    const stale = current.length !== findings.length
      || current.some((finding, index) => finding.file !== findings[index].file || finding.line !== findings[index].line);
    if (stale) {
      stdout.write('The board changed while repairing; nothing was written. Run `gw repair` again.\n');
      return 1;
    }

    const quarantined = [];
    for (const file of AUDITED) {
      const fileFindings = findings.filter((finding) => finding.file === file);
      if (!fileFindings.length) continue;
      const path = store.paths[file];
      const raw = readFileSync(path, 'utf8');
      const lines = raw.split('\n');
      const badLines = new Set(fileFindings.map((finding) => finding.line));
      // Quarantine first, rewrite second: if the process dies between the two,
      // the data exists in both places, never in neither.
      const now = new Date().toISOString();
      for (const finding of fileFindings) {
        appendFileSync(store.paths.quarantine, `${JSON.stringify({ ts: now, file: `${finding.file}.jsonl`, line: finding.line, problem: finding.problem, raw: finding.raw })}\n`);
      }
      const kept = lines.filter((_, index) => !badLines.has(index + 1));
      writeFileSync(path, kept.length ? kept.join('\n') : '');
      quarantined.push(...fileFindings);
    }

    // The repair is a gw write like any other, so it must not read as
    // tampering: re-baseline the digest or the next `gw check` reports the
    // files the tool itself just fixed.
    store.rebaselineDigest();

    for (const finding of quarantined) stdout.write(`${finding.file}.jsonl: line ${finding.line} quarantined\n`);
    stdout.write(`Repaired: ${quarantined.length} bad line(s) moved to .gatewright/quarantine.jsonl; nothing was deleted; digest re-baselined.\n`);
    return 0;
  });
}
