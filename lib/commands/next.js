import { readStages } from '../config.js';
import { stageOrderMessage } from '../rules.js';
import { transitionsFor } from '../transitions.js';
import { UsageError } from '../cli/errors.js';

export const spec = {
  summary: 'show what stage(s) an item can move to now, and why not for the rest',
  flags: { json: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }],
};

// The refusal `gw move` gives is deliberately about one target at a time. An
// agent that has never seen the pipeline has no way to turn that refusal into
// a plan without reading stages.json itself. This reuses the exact evaluator
// the live board's `/api/items/<id>/transitions` endpoint uses (lib/transitions.js)
// so the CLI, the board, and `gw move`'s own refusals never disagree about
// what is actually blocking an item.
function orderNote(id, item, stageId, stages) {
  const terminal = (stages.terminal ?? []).includes(item.stage);
  if (terminal) {
    return `${item.stage} is a terminal stage; leaving it needs --force: run \`gw move ${id} ${stageId} --force\``;
  }
  return stageOrderMessage(id, item.stage, stageId, stages);
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

  const ready = entries.filter((entry) => entry.ok && !entry.force);
  const blocked = entries.filter((entry) => !entry.ok || entry.force);

  ctx.stdout.write(`${id}  stage: ${item.stage}\n`);

  ctx.stdout.write('\ncan move to now:\n');
  if (ready.length) {
    for (const entry of ready) ctx.stdout.write(`  ${entry.stage}: run \`gw move ${id} ${entry.stage}\`\n`);
  } else {
    ctx.stdout.write('  (nothing yet)\n');
  }

  if (blocked.length) {
    ctx.stdout.write('\ncannot move to yet:\n');
    for (const entry of blocked) {
      ctx.stdout.write(`  ${entry.stage}:\n`);
      if (entry.force) ctx.stdout.write(`    - ${orderNote(id, item, entry.stage, stages)}\n`);
      for (const reason of entry.reasons ?? []) ctx.stdout.write(`    - ${reason}\n`);
    }
  }
}
