import { readStages } from '../config.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';

export const spec = { summary: 'approve or drop a held item', flags: { approve: { type: 'boolean' }, drop: { type: 'boolean' }, by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] };

export function run(ctx) {
  const [id] = ctx.positionals; const approve = Boolean(ctx.flags.approve); const drop = Boolean(ctx.flags.drop);
  if (approve === drop) throw new UsageError('use exactly one of --approve or --drop');
  const stages = readStages(ctx.store); const roles = resolveRoles(stages);
  return ctx.store.withLock(() => {
    const items = ctx.store.readItems(); const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    const item = items[index];
    if (item.flag !== 'needs-triage') throw new RuleError(`item ${id} is not held for triage`);
    if (drop && !roles.dropped) throw new RuleError('cannot drop this item: the pipeline has no dropped role');
    const updated = { ...item, flag: null, updated: new Date().toISOString() };
    if (approve) {
      items[index] = updated; ctx.store.writeItems(items);
      ctx.store.appendEvent({ type: 'flag', item: id, flag: null, by: ctx.actor, reason: 'triage approved' });
      ctx.stdout?.write(`${id}  triage approved\n`);
    } else {
      updated.stage = roles.dropped; items[index] = updated; ctx.store.writeItems(items);
      ctx.store.appendEvent({ type: 'move', item: id, from: item.stage, to: roles.dropped, by: ctx.actor, evidence: [] });
      ctx.stdout?.write(`${id}  triage dropped\n`);
    }
  });
}
