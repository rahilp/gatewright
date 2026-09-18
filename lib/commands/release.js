import { UsageError, RuleError } from '../cli/errors.js';
import { sameOwner } from '../owner.js';
export const spec = { summary: 'release an item', flags: { force: { type: 'boolean' }, by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] };
export function run(ctx) {
  return ctx.store.withLock(() => {
    const items = ctx.store.readItems();
    const item = items.find((candidate) => candidate.id === ctx.positionals[0]);
    if (!item) throw new UsageError(`unknown item: ${ctx.positionals[0]}`);
    // T-0084 — release was the side door around the claim lock: a second agent
    // was refused at `claim` (which demands --force) yet could `release` the
    // item to null with no output at all, leaving the owner holding a lock
    // that no longer existed. The refusal mirrors move's non-owner refusal
    // (same owner rule, same way out), and a successful release says what it
    // did -- a silent state change to someone else's claim is not a default.
    if (item.owner && !sameOwner(item.owner, ctx.actor) && !ctx.flags.force) {
      throw new RuleError(`item ${item.id} is owned by ${item.owner}, and you are ${ctx.actor}: run \`gw claim ${item.id} --force\` to take it over first, or pass --force to this release as a deliberate one-off.`);
    }
    const previous = item.owner;
    item.owner = null;
    item.updated = new Date().toISOString();
    ctx.store.writeItems(items);
    ctx.store.appendEvent({ type: 'release', item: item.id, by: ctx.actor });
    ctx.stdout?.write(`${item.id}  released${previous ? `  ·  was owned by ${previous}` : ''}\n`);
  });
}
