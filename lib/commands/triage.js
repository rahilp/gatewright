import { readStages } from '../config.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';
import { sameOwner } from '../owner.js';

export const spec = { summary: 'approve or drop a held item', flags: { approve: { type: 'boolean' }, drop: { type: 'boolean' }, by: { type: 'string' }, force: { type: 'boolean' } }, positionals: [{ name: 'id', required: true }] };

export function run(ctx) {
  const [id] = ctx.positionals; const approve = Boolean(ctx.flags.approve); const drop = Boolean(ctx.flags.drop); const force = Boolean(ctx.flags.force);
  if (approve === drop) throw new UsageError('use exactly one of --approve or --drop');
  const stages = readStages(ctx.store); const roles = resolveRoles(stages);
  return ctx.store.withLock(() => {
    const items = ctx.store.readItems(); const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    const item = items[index];
    if (item.flag !== 'needs-triage') throw new RuleError(`item ${id} is not held for triage`);
    // T-0036 — needs-triage holds unreviewed work off the scheduler until a
    // human looks at it. Letting the approving actor be the same person who
    // created the item gates no one: an agent approves its own work and the
    // hold means nothing. So the creator cannot --approve their own item --
    // with one deliberate override, --force, that says the review was done
    // out of band. --drop stays open to the creator: discarding your own
    // work needs no second pair of eyes.
    if (approve && !force && sameOwner(item.created_by, ctx.actor)) {
      // T-0080: the same refusal reaches two audiences. The terminal keeps the
      // command -- it is the one place a command is runnable advice. A browser
      // panel gets the message verbatim from the 409 (T-0018), so it travels
      // with a decision-naming browserMessage the server prefers; the decision
      // is the same one, stated without a command the reader cannot run.
      const error = new RuleError(
        `item ${id} was created by ${item.created_by ?? 'an unknown actor'}, and needs-triage exists so someone else reviews it: you cannot approve your own item. `
        + `Another actor must run \`gw triage ${id} --approve\` — or pass --force to approve it yourself as a deliberate override.`,
      );
      error.browserMessage = `item ${id} was created by ${item.created_by ?? 'an unknown actor'}, and needs-triage exists so someone else reviews it: you cannot approve your own item. Someone else has to approve the hold — you can still drop it here if the item should not go ahead.`;
      throw error;
    }
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
