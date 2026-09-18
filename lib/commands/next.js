import { readStages } from '../config.js';
import { nextStage, stageIndex } from '../rules.js';
import { transitionsFor } from '../transitions.js';
import { blockedDep } from '../brief.js';
import { UsageError } from '../cli/errors.js';

export const spec = {
  summary: 'show what stage(s) an item can move to now, and why not for the rest',
  flags: { json: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }],
};

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
      }
      if (beyond.length) {
        const plural = beyond.length === 1 ? 'stage' : 'stages';
        ctx.stdout.write(`  - ${beyond.length} further ${plural} need this first\n`);
      }
    }
    ctx.stdout.write('\n');
  } else {
    ctx.stdout.write(`${item.stage} has no forward pipeline move from here; any pipeline stage needs --force.\n\n`);
  }

  ctx.stdout.write(`other moves: ${summarizeOthers(otherEntries)}\n`);
}
