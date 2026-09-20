import { readStages } from '../config.js';
import { nextStage, stageIndex } from '../rules.js';
import { transitionsFor } from '../transitions.js';
import { blockedDep, strandedDepFix, tamperBanner } from '../brief.js';
import { UsageError } from '../cli/errors.js';
import { triageAdvice } from '../owner.js';

export const spec = {
  summary: 'show what stage(s) an item can move to now, and why not for the rest',
  flags: { json: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }],
};

// How many later stages `next` names before it stops listing them. Long
// enough for every shipped pipeline; short enough that a 20-stage board does
// not bury the unmet rules above it.
const BEYOND_NAMED = 4;

// T-0037 — the group labels used to be arrows ("ready -> dropped"), which
// read as a stage named `ready` sitting next to real stage names. The stages
// come first and the condition is a parenthetical, so every token that looks
// like a stage id is one.
function summarizeOthers(entries) {
  const ready = entries.filter((entry) => entry.ok && !entry.force).map((entry) => entry.stage);
  const needsForce = entries.filter((entry) => entry.force).map((entry) => entry.stage);
  const blocked = entries.filter((entry) => !entry.ok && !entry.force).map((entry) => entry.stage);

  const groups = [];
  if (ready.length) groups.push(`${ready.join(', ')} (now)`);
  if (needsForce.length) groups.push(`${needsForce.join(', ')} (needs --force)`);
  if (blocked.length) groups.push(`${blocked.join(', ')} (blocked)`);
  return groups.length ? groups.join('; ') : '(none)';
}

export function run(ctx) {
  const id = ctx.positionals[0];
  const stages = readStages(ctx.store);
  const items = ctx.store.readItems();
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new UsageError(`unknown item: ${id}`);

  const transitions = transitionsFor(item, items, stages);
  const entries = Object.entries(transitions).map(([stage, verdict]) => ({ stage, ...verdict }));

  if (ctx.flags.json) {
    ctx.stdout.write(`${JSON.stringify({ id, stage: item.stage, transitions })}\n`);
    return;
  }

  const warning = tamperBanner(ctx.store.verifyDigest());
  if (warning) ctx.stdout.write(`${warning}\n`);

  ctx.stdout.write(`${id}  stage: ${item.stage}\n\n`);

  const terminal = (stages.terminal ?? []).includes(item.stage);
  const currentIndex = stageIndex(stages, item.stage);
  const nextId = terminal || currentIndex < 0 ? null : nextStage(stages, item.stage);

  let otherEntries = entries;

  if (terminal) {
    ctx.stdout.write(`${item.stage} is a terminal stage; leaving it needs --force.\n\n`);
  } else if (nextId) {
    const nextEntry = entries.find((entry) => entry.stage === nextId);
    // Stages more than one hop ahead never get their own explanation here --
    // they would just restate the same unmet rules the immediate next stage
    // already reported. Collapse them to a count and drop them from "other
    // moves" so they cannot leak in as noise either.
    const beyond = entries.filter((entry) => {
      const index = stageIndex(stages, entry.stage);
      return index >= 0 && index > currentIndex && entry.stage !== nextId;
    });
    otherEntries = entries.filter((entry) => entry.stage !== nextId && !beyond.includes(entry));

    if (nextEntry.ok) {
      ctx.stdout.write(`next: ${nextId} (ready): run \`gw move ${id} ${nextId}\`\n`);
    } else {
      ctx.stdout.write(`next: ${nextId} (blocked)\n`);
      // A triage hold is a policy boundary, not just another unmet gate. It
      // must be named before generic gate reasons (which often only say an
      // owner is missing), because `next` is the command an agent is told to
      // trust when it needs to know why it cannot advance.
      if (item.flag === 'needs-triage') {
        ctx.stdout.write(`  - held for triage: ${triageAdvice(item, ctx.actor)} before it can advance\n`);
      }
      for (const reason of nextEntry.reasons ?? []) ctx.stdout.write(`  - ${reason}\n`);
      // T-0045 — the gate sentences name conditions, not the item causing
      // them, so an item stuck behind a dependency was told "someone must
      // have claimed it" and never which dependency was in the way. The
      // brief's BLOCKED section already names it; next must answer with the
      // same dependency, in the same words.
      const waitingOn = blockedDep(item, items, stages);
      if (waitingOn) {
        const depStage = items.find((candidate) => candidate.id === waitingOn)?.stage;
        ctx.stdout.write(`  - waiting on ${waitingOn}${depStage ? ` (${depStage})` : ''}\n`);
        // T-0073 — a dependency that can never advance (dropped, or terminal
        // by any other route) strands this item with no move that helps: the
        // one failure state in the product that named no command. The fix is
        // shared with the brief's BLOCKED rows so the two cannot drift, and
        // it is exact: the item's other deps survive the edit.
        const fix = strandedDepFix(item, items, stages);
        if (fix) ctx.stdout.write(`  - it cannot advance: run \`${fix}\` to remove it from the deps\n`);
      }
      // T-0138 — this line read "1 further stage need this first": the
      // agreement was wrong, and it never said WHICH stages, so the one fact
      // it carried (what is waiting on this move) could not be acted on. The
      // stages are named now, and a long pipeline is capped so a list of
      // reasons stays a list of reasons.
      if (beyond.length) {
        const names = beyond.map((entry) => entry.stage);
        const shown = names.slice(0, BEYOND_NAMED);
        const rest = names.length - shown.length;
        const named = [...shown, ...(rest ? [`and ${rest} more`] : [])].join(', ');
        ctx.stdout.write(`  - ${names.length} further ${names.length === 1 ? 'stage needs' : 'stages need'} this first: ${named}\n`);
      }
    }
    ctx.stdout.write('\n');
  } else {
    ctx.stdout.write(`${item.stage} has no forward pipeline move from here; any pipeline stage needs --force.\n\n`);
  }

  ctx.stdout.write(`other moves: ${summarizeOthers(otherEntries)}\n`);
}
