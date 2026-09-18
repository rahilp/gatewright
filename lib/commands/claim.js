import { UsageError, RuleError } from '../cli/errors.js';
import { sameOwner } from '../owner.js';
export const spec = { summary: 'claim an item', flags: { force: { type: 'boolean' }, by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] };
export function run(ctx) { return ctx.store.withLock(() => { const items = ctx.store.readItems(); const item = items.find((i) => i.id === ctx.positionals[0]); if (!item) throw new UsageError(`unknown item: ${ctx.positionals[0]}`); if (sameOwner(item.owner, ctx.actor)) return; if (item.owner && !ctx.flags.force) throw new RuleError(`item ${item.id} is already owned by ${item.owner}; run \`gw claim ${item.id} --force\` to take it over`); item.owner = ctx.actor; item.updated = new Date().toISOString(); ctx.store.writeItems(items); ctx.store.appendEvent({ type: 'claim', item: item.id, by: ctx.actor });
    // T-0089 — claim on a held item is deliberate: claiming unreviewed work is
    // harmless and a useful signal. But silence is not — the very next command
    // (move) refuses naming the hold, so the claim must say the item is held
    // too, or an agent discovers the hold one command after it committed.
    if (item.flag === 'needs-triage') ctx.stdout?.write(`${item.id}  claimed  ·  held for triage: someone other than its creator must run \`gw triage ${item.id} --approve\` before it can advance\n`); }); }
