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
// - a rewrite restores the prior digest when it only removes corrupt bytes;
//   if valid content was already tampered with, repair leaves that digest
//   stale unless the caller deliberately supplies --force;
// - it is a DRY RUN by default. --write is the deliberate step.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { readStages } from '../config.js';
import { stageList, FLAGS } from '../rules.js';
import { isTerminalStage, resolveRoles } from '../stages.js';

export const spec = {
  summary: 'quarantine corrupt lines from the board files so it loads again (dry run by default)',
  flags: { write: { type: 'boolean' }, force: { type: 'boolean' } },
  positionals: [],
};

// items.jsonl and events.jsonl are the two line-oriented files; stages.json
// and config.json are read whole as JSON, so their failure mode is one bad
// file, not one bad line, and git history is the remedy for those.
const AUDITED = ['items', 'events'];

// T-0071 — a finding carries a kind. 'parse' means the line is corrupt in a
// way that breaks the board's loading: unparseable, not an object, missing the
// one field every reader keys on. 'content' means the line parses fine and the
// board loads — it is simply wrong (an item whose stage no board defines),
// which is a correctness problem, and correctness belongs to `gw check`.
// A 'content' line is reported, never quarantined: quarantine would make an
// item vanish from the board as a side effect of a repair nobody directed,
// and repair's promise is "the board loads again", not "the board is right".
function auditLine(file, line, index, stageIds) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { kind: 'parse', problem: `not valid JSON (${error.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'parse', problem: 'is not a JSON object' };
  if (file === 'items') {
    if (typeof parsed.id !== 'string') return { kind: 'parse', problem: 'is an item without an "id"' };
    // Valid JSON is not a valid item: stage and flag are judged against the
    // board's own vocabulary, independently of the digest. When stages.json
    // itself cannot be read, this check steps aside (fail-open, like the
    // commit hook) so parse-level repair still works.
    if (stageIds && (typeof parsed.stage !== 'string' || !stageIds.has(parsed.stage))) {
      return { kind: 'content', problem: `has stage ${JSON.stringify(parsed.stage)}, which is not a stage on this board` };
    }
    if (stageIds && parsed.flag != null && !FLAGS.includes(parsed.flag)) {
      return { kind: 'content', problem: `has flag ${JSON.stringify(parsed.flag)}, which is not a flag this board knows` };
    }
  }
  if (file === 'events' && typeof parsed.type !== 'string') return { kind: 'parse', problem: 'is an event without a "type"' };
  return null;
}

// Stages define the vocabulary the content check judges against. Unreadable
// stages.json yields null: audit for corruption, skip the content checks.
function stageIdsFor(store) {
  try {
    return new Set(stageList(readStages(store)).map((stage) => stage.id));
  } catch {
    return null;
  }
}

function staleTriageHolds(store) {
  try {
    const stages = readStages(store);
    const roles = resolveRoles(stages);
    return store.readItems().filter((item) => item.flag === 'needs-triage' && isTerminalStage(item.stage, stages, roles));
  } catch {
    // A broken stages file is separately actionable. Do not guess which items
    // are terminal while it cannot define that word.
    return [];
  }
}

function clearStaleTriageHolds(store, actor) {
  const stale = staleTriageHolds(store);
  if (!stale.length) return [];
  const staleIds = new Set(stale.map((item) => item.id));
  const now = new Date().toISOString();
  store.writeItems(store.readItems().map((item) => staleIds.has(item.id) ? { ...item, flag: null, updated: now } : item));
  for (const item of stale) {
    store.appendEvent({
      type: 'flag', item: item.id, flag: null, by: actor,
      repaired_by: actor, reason: 'stale triage hold cleared from finished item',
    });
  }
  return stale;
}

// Physical line numbers, blank lines included, so a number printed here is
// the number an editor shows — the number a person has to act on.
function audit(store) {
  const findings = [];
  const stageIds = stageIdsFor(store);
  for (const file of AUDITED) {
    const path = store.paths[file];
    if (!existsSync(path)) continue;
    const raw = readFileSync(path, 'utf8');
    if (raw === '') continue;
    raw.split('\n').forEach((line, index) => {
      if (line.trim() === '') return;
      const problem = auditLine(file, line, index, stageIds);
      if (problem) findings.push({ file, line: index + 1, ...problem, raw: line });
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
  const staleHolds = staleTriageHolds(store);
  if (!findings.length) {
    if (staleHolds.length) {
      if (!ctx.flags.write) {
        for (const item of staleHolds) stdout.write(`items.jsonl: ${item.id} is finished in ${item.stage} but still has needs-triage\n`);
        stdout.write(`Found ${staleHolds.length} stale triage hold(s) on finished work. Dry run — nothing changed. Run again with --write to clear them and record flag events.\n`);
        return 0;
      }
      return store.withLock(() => {
        const cleared = clearStaleTriageHolds(store, ctx.actor);
        if (!cleared.length) {
          stdout.write('Board files are clean. Nothing to repair.\n');
          return 0;
        }
        stdout.write(`Repaired: cleared ${cleared.length} stale triage hold(s) from finished work; recorded flag events.\n`);
        return 0;
      });
    }
    // A first `repair --write` can remove a corrupt line while deliberately
    // preserving a stale digest for surviving, valid-but-out-of-band content.
    // Its printed follow-up command is `gw repair --write --force`; by the
    // time that command runs there is no corruption left to audit, but there
    // is still a known digest mismatch for it to accept. Do that exact
    // deliberate re-baseline here rather than making the promised path depend
    // on a second corrupt line existing.
    if (ctx.flags.write && ctx.flags.force) {
      const digest = store.verifyDigest();
      if (digest.status === 'modified') {
        return store.withLock(() => {
          // Verify again under the lock. A concurrent gw write could have
          // restored the digest between the first audit and this acceptance.
          if (store.verifyDigest().status === 'modified') {
            store.rebaselineDigest();
            stdout.write('Board files are clean. Digest re-baselined by explicit recovery.\n');
          } else {
            stdout.write('Board files are clean. Nothing to repair.\n');
          }
          return 0;
        });
      }
    }
    stdout.write('Board files are clean. Nothing to repair.\n');
    return 0;
  }
  // Two kinds of bad line, two remedies: 'parse' lines are quarantined by
  // --write; 'content' lines are only ever reported, here and by `gw check`.
  const corrupt = findings.filter((finding) => finding.kind === 'parse');
  const invalid = findings.filter((finding) => finding.kind === 'content');
  if (!ctx.flags.write) {
    report(findings);
    stdout.write(`Found ${findings.length} bad line(s) (${corrupt.length} unparseable, ${invalid.length} valid JSON but invalid content). Dry run — nothing changed.\nRun again with --write to quarantine the unparseable one(s) in .gatewright/quarantine.jsonl and repair the board.\n`);
    if (invalid.length) stdout.write('Lines that parse but carry invalid content are reported, not quarantined — the board still loads; `gw check` fails until they are corrected.\n');
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

    const digestBefore = store.verifyDigest();
    const quarantined = [];
    for (const file of AUDITED) {
      // Only parse-level corruption is quarantined. A content finding names a
      // line that loads fine; removing it would be an edit nobody directed.
      const fileFindings = findings.filter((finding) => finding.file === file && finding.kind === 'parse');
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

    // Removing a merely corrupt suffix restores the previous digest exactly.
    // If it does not, there was already a valid out-of-band write among the
    // surviving board data. Do not turn that into trusted history just because
    // repair also had legitimate work to do.
    const digestAfter = quarantined.length ? store.verifyDigest() : digestBefore;
    let rebaselined = false;
    if (quarantined.length && digestAfter.status === 'unknown') {
      // There is no prior digest to preserve (fresh/legacy board), so this is
      // the normal migration baseline rather than accepting a known mismatch.
      store.rebaselineDigest();
      rebaselined = true;
    } else if (quarantined.length && digestAfter.status === 'modified' && ctx.flags.force) {
      store.rebaselineDigest();
      rebaselined = true;
    }

    for (const finding of quarantined) stdout.write(`${finding.file}.jsonl: line ${finding.line} quarantined\n`);
    if (quarantined.length && digestAfter.status === 'clean') stdout.write(`Repaired: ${quarantined.length} bad line(s) moved to .gatewright/quarantine.jsonl; nothing was deleted; prior digest restored.\n`);
    if (quarantined.length && rebaselined) stdout.write(`Repaired: ${quarantined.length} bad line(s) moved to .gatewright/quarantine.jsonl; nothing was deleted; digest re-baselined by explicit recovery.\n`);
    if (quarantined.length && digestAfter.status === 'modified' && !ctx.flags.force) {
      stdout.write(`Repaired: ${quarantined.length} bad line(s) moved to .gatewright/quarantine.jsonl; nothing was deleted; digest remains stale because surviving board content differs from the prior digest. Run \`gw check\` to inspect it. After deliberate review, run \`gw repair --write --force\` to re-baseline.\n`);
    }
    // T-0071 — said loudly, twice over: here, and as this command's exit code.
    // The re-baseline above cannot legitimise these lines; `gw check` judges
    // item shape independently of the digest and keeps failing until they are
    // corrected.
    for (const finding of invalid) {
      stdout.write(`${finding.file}.jsonl: line ${finding.line} ${finding.problem} — reported, not quarantined: the line parses, so the board loads; \`gw check\` fails until it is corrected.\n`);
    }
    const cleared = clearStaleTriageHolds(store, ctx.actor);
    if (cleared.length) stdout.write(`Repaired: cleared ${cleared.length} stale triage hold(s) from finished work; recorded flag events.\n`);
    return invalid.length || (quarantined.length && digestAfter.status === 'modified' && !ctx.flags.force) ? 1 : 0;
  });
}
