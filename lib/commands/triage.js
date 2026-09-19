import { readStages } from '../config.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';
import { isOwnAgentTriage, triageAdvice } from '../owner.js';

export const spec = { summary: 'approve or drop a held item', flags: { approve: { type: 'boolean' }, drop: { type: 'boolean' }, by: { type: 'string' }, force: { type: 'boolean' } }, positionals: [{ name: 'id', required: true }] };

function defaultActorInCursor(ctx) {
  return Boolean(ctx.env?.CURSOR_AGENT) && !ctx.flags.by && !ctx.env?.GW_ACTOR;
}

function defaultActor(ctx) {
  return !ctx.flags.by && !ctx.env?.GW_ACTOR;
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
    // A second agent is a valid reviewer. The one boundary is self-review,
    // and --force is deliberately irrelevant to it.
    if (approve && isOwnAgentTriage(item, ctx.actor)) {
      // T-0080: the same refusal reaches two audiences. The terminal keeps the
      // command -- it is the one place a command is runnable advice. A browser
      // panel gets the message verbatim from the 409 (T-0018), so it travels
      // with a decision-naming browserMessage the server prefers; the decision
      // is the same one, stated without a command the reader cannot run.
      const error = new RuleError(
        `item ${id} is held for needs-triage because it was created by ${item.created_by ?? 'an unknown actor'}. `
        + `${triageAdvice(item, ctx.actor)}. --force does not allow self-approval.`,
      );
      error.browserMessage = `item ${id} is held for needs-triage because it was created by ${item.created_by ?? 'an unknown actor'}. You cannot approve your own item; ask a human or a different agent to approve it, or drop it if it should not go ahead.`;
      throw error;
    }
    if (approve && defaultActorInCursor(ctx)) {
      throw new RuleError(`refusing to approve ${id}: Cursor Agent is present but GW_ACTOR is unset, so this approval would be recorded as ${ctx.actor}. Set \`GW_ACTOR=agent:<name>\` and retry as a different agent, ask a human to approve it, or turn off holds for agent-created items with \`gw config policy.triage_required_for none\`. Identity is declared, not authenticated.`);
    }
    if (drop && !roles.dropped) throw new RuleError('cannot drop this item: the pipeline has no dropped role');
    const updated = { ...item, flag: null, updated: new Date().toISOString() };
    if (approve) {
      items[index] = updated; ctx.store.writeItems(items);
      ctx.store.appendEvent({ type: 'flag', item: id, flag: null, by: ctx.actor, approved_by: ctx.actor, reason: `triage approved by ${ctx.actor}` });
      if (defaultActor(ctx) && item.created_by?.startsWith('agent:')) {
        ctx.stderr?.write(`gw: warning: GW_ACTOR is unset; approval identity is declared, not authenticated. Set GW_ACTOR=agent:<name> when acting as an agent.\n`);
      }
      ctx.stdout?.write(`${id}  triage approved\n`);
    } else {
      updated.stage = roles.dropped; items[index] = updated; ctx.store.writeItems(items);
      ctx.store.appendEvent({ type: 'move', item: id, from: item.stage, to: roles.dropped, by: ctx.actor, evidence: [] });
      ctx.stdout?.write(`${id}  triage dropped\n`);
    }
  });
}
