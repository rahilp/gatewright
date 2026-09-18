import { readStages } from '../config.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';

export const spec = { summary: 'approve or drop a held item', flags: { approve: { type: 'boolean' }, drop: { type: 'boolean' }, by: { type: 'string' }, force: { type: 'boolean' } }, positionals: [{ name: 'id', required: true }] };

function actorParts(actor) {
  const text = String(actor ?? '');
  const match = /^(human|agent):(.+)$/.exec(text);
  // Runtime actors are qualified in cli/root.js. Treating a bare direct-call
  // actor as human maintains that public default while still matching the
  // name below, which closes the omitted-GW_ACTOR alias.
  return match ? { kind: match[1], name: match[2] } : { kind: 'human', name: text };
}

export function run(ctx) {
  const [id] = ctx.positionals; const approve = Boolean(ctx.flags.approve); const drop = Boolean(ctx.flags.drop);
  if (approve === drop) throw new UsageError('use exactly one of --approve or --drop');
  const stages = readStages(ctx.store); const roles = resolveRoles(stages);
  return ctx.store.withLock(() => {
    const items = ctx.store.readItems(); const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    const item = items[index];
    if (item.flag !== 'needs-triage') throw new RuleError(`item ${id} is not held for triage`);
    // T-0085 — `needs-triage` is the human-review boundary for agent-created
    // work. The item's immutable provenance, not a caller-provided `--force`,
    // decides whether that boundary applies. An agent-created item therefore
    // needs a different human approver: no agent may approve it, and
    // human:<same-name> is treated as the omitted-GW_ACTOR alias rather than
    // a new reviewer. Human-created items remain self-approvable for solo
    // users. Dropping your own item is always safe.
    const creator = actorParts(item.created_by);
    const approver = actorParts(ctx.actor);
    if (approve && creator.kind === 'agent' && (approver.kind !== 'human' || approver.name === creator.name)) {
      // T-0080: the same refusal reaches two audiences. The terminal keeps the
      // command -- it is the one place a command is runnable advice. A browser
      // panel gets the message verbatim from the 409 (T-0018), so it travels
      // with a decision-naming browserMessage the server prefers; the decision
      // is the same one, stated without a command the reader cannot run.
      const error = new RuleError(
        `item ${id} is held for needs-triage because it was created by ${item.created_by ?? 'an unknown actor'} and needs a different human approver. `
        + `Agents cannot approve agent-created items, and the creator's human alias cannot approve it either. A different human must run \`gw triage ${id} --approve\`; you may still run \`gw triage ${id} --drop\`.`,
      );
      error.browserMessage = `item ${id} is held for needs-triage because it was created by ${item.created_by ?? 'an unknown actor'} and needs a different human approver. Agents and the creator's human alias cannot approve the hold; you can still drop it here if the item should not go ahead.`;
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
