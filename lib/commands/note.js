import { UsageError } from '../cli/errors.js';
export const spec = { summary: 'append a note', flags: { by: { type: 'string' } }, positionals: [{ name: 'id', required: true }, { name: 'text', required: true }] };
// T-0013 — an empty note is a paste error, not a thought: refusing it keeps
// the event log free of `[timestamp] ` lines that say nothing.
export function run(ctx) { const text = ctx.positionals[1]; if (!text.trim()) throw new UsageError('note text must not be empty'); return ctx.store.withLock(() => { const items = ctx.store.readItems(); const item = items.find((i) => i.id === ctx.positionals[0]); if (!item) throw new UsageError(`unknown item: ${ctx.positionals[0]}`); const now = new Date().toISOString(); item.notes = item.notes ? `${item.notes}\n[${now}] ${text}` : `[${now}] ${text}`; item.updated = now; ctx.store.writeItems(items); ctx.store.appendEvent({ type: 'note', item: item.id, by: ctx.actor, note: text }); }); }
