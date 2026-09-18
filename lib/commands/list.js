import { readStages } from '../config.js';
import { stageList } from '../rules.js';
import { UsageError } from '../cli/errors.js';
import { sanitizeTitle } from '../brief.js';

export const spec = { summary: 'list items, filtered by stage, phase, or flag', flags: { stage: { type: 'string' }, phase: { type: 'string' }, flag: { type: 'string' }, json: { type: 'boolean' } } };

export function run(ctx) {
  // T-0044 — an unknown stage used to filter to zero rows and exit 0,
  // indistinguishable from an empty stage. `move` refuses an unknown stage at
  // exit 2; list must give the same answer, naming the stages that do exist.
  if (ctx.flags.stage) {
    const stages = readStages(ctx.store);
    const known = stageList(stages).map((stage) => stage.id);
    if (!known.includes(ctx.flags.stage)) {
      throw new UsageError(`unknown stage: ${ctx.flags.stage}; valid stages: ${known.join(', ')}`);
    }
  }
  const items = ctx.store.readItems().filter((item) => (!ctx.flags.stage || item.stage === ctx.flags.stage) && (!ctx.flags.phase || item.phase === ctx.flags.phase) && (!ctx.flags.flag || item.flag === ctx.flags.flag));
  if (ctx.flags.json) { ctx.stdout.write(`${JSON.stringify(items)}\n`); return; }
  // Titles go through the same one-row-per-item sanitiser the brief uses, so
  // a title holding a newline (T-0009) renders as one row, not two.
  for (const item of items) ctx.stdout.write(`${item.id}  ${item.stage ?? '-'}  ${sanitizeTitle(item.title)}\n`);
}
