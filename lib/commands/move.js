import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, nextStage, stageIndex, stageList, stageOrderMessage } from '../rules.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';
import { createMemory } from '../memory/provider.js';
import { rememberCompleted } from '../memory/write.js';

export const spec = {
  summary: 'advance an item when its target-stage evidence rule is met',
  flags: { evidence: { type: 'string', repeat: true }, by: { type: 'string' }, force: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }, { name: 'stage', required: true }],
};

export function run(ctx) {
  const [id, to] = ctx.positionals;
  const stages = readStages(ctx.store);
  const roles = resolveRoles(stages);
  const config = readConfig(ctx.store);
  const target = stageList(stages).find((stage) => stage.id === to);
  const evidence = ctx.flags.evidence ?? [];

  let completed;
  const result = ctx.store.withLock(() => {
    const items = ctx.store.readItems();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    if (!target) throw new UsageError(`unknown stage: ${to}`);
    const current = items[index];
    const sideTarget = stageIndex(stages, to) < 0;
    if ((stages.terminal ?? []).includes(current.stage) && (!ctx.flags.force || !sideTarget)) throw new UsageError(`item ${id} is finished in terminal stage ${current.stage}; if this is a mistake, run \`gw move ${id} <side-stage> --force\``);
    if (current.stage === to) throw new UsageError(`item ${id} is already in stage ${to}; run \`gw show ${id}\` to inspect it`);

    // Extras are intentional departures from the linear pipeline. Every other
    // transition has to be exactly one pipeline step unless the caller opts in.
    if (!sideTarget && !ctx.flags.force && nextStage(stages, current.stage) !== to) {
      throw new RuleError(stageOrderMessage(id, current.stage, to, stages));
    }

    // Evidence supplied by this move is part of the proof for entering target.
    const proposed = { ...current, evidence: [...(current.evidence ?? []), ...evidence] };
    const verdict = evaluateCumulative(proposed, to, { items, stages });
    if (!verdict.ok) throw new RuleError('target stage requirements are not met', verdict.failures);

    const moved = { ...proposed, stage: to, updated: new Date().toISOString() };
    if (current.stage === roles.paused && moved.flag === 'paused') moved.flag = null;
    items[index] = moved;
    ctx.store.writeItems(items);
    const queuedComment = Boolean(config.github?.enabled && current.gh && config.github?.comment_on_move);
    ctx.store.appendEvent({ type: 'move', item: id, from: current.stage, to, by: ctx.actor, evidence, ...(queuedComment ? { queued_comment: true } : {}) });
    ctx.stdout.write(`${id}  ${current.stage} → ${to}  ·  evidence: ${evidence.join(', ')}\n`);
    if (config.memory?.enabled && config.memory.remember?.on_close && to === config.github?.close_on) completed = { item: moved, from: current.stage, to };
  });
  // A close is one event and receives one independent memory, even if it
  // follows a successful run on the same item.
  if (completed) {
    const memory = createMemory({ config, transport: ctx.memoryTransport, log: { root: ctx.store.root } });
    void rememberCompleted({ memory, root: ctx.store.root, config, ...completed, verified: true });
  }
  return result;
}
