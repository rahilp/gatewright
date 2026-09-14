import { UsageError } from '../cli/errors.js';
export const spec = { summary: 'release an item', flags: { by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] };
export function run(ctx) { return ctx.store.withLock(() => { const items = ctx.store.readItems(); const item = items.find((i) => i.id === ctx.positionals[0]); if (!item) throw new UsageError(`unknown item: ${ctx.positionals[0]}`); item.owner = null; item.updated = new Date().toISOString(); ctx.store.writeItems(items); ctx.store.appendEvent({ type: 'release', item: item.id, by: ctx.actor }); }); }
