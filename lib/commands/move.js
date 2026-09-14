import { readConfig, readStages } from '../config.js';
import { evaluateRequires, nextStage, stageIndex, stageList } from '../rules.js';
import { RuleError, UsageError } from '../cli/errors.js';

export const spec = {
  summary: 'advance an item when its target-stage evidence rule is met',
  flags: { evidence: { type: 'string', repeat: true }, by: { type: 'string' }, force: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }, { name: 'stage', required: true }],
};

export function run(ctx) {
  const [id, to] = ctx.positionals;
  const stages = readStages(ctx.store);
  const config = readConfig(ctx.store);
  const target = stageList(stages).find((stage) => stage.id === to);
  const evidence = ctx.flags.evidence ?? [];

  return ctx.store.withLock(() => {
    const items = ctx.store.readItems();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    if (!target) throw new UsageError(`unknown stage: ${to}`);
    const current = items[index];
    if ((stages.terminal ?? []).includes(current.stage)) throw new UsageError(`item ${id} is already in terminal stage ${current.stage}`);
    if (current.stage === to) throw new UsageError(`item ${id} is already in stage ${to}`);

    // Extras are intentional departures from the linear pipeline. Every other
    // transition has to be exactly one pipeline step unless the caller opts in.
    const sideTarget = stageIndex(stages, to) < 0;
    if (!sideTarget && !ctx.flags.force && nextStage(stages, current.stage) !== to) {
      throw new RuleError('use --force to skip stages');
    }

    // Evidence supplied by this move is part of the proof for entering target.
    const proposed = { ...current, evidence: [...(current.evidence ?? []), ...evidence] };
    const verdict = evaluateRequires(proposed, to, { items, stages });
    if (!verdict.ok) throw new RuleError('target stage requirements are not met', verdict.failures);

    const moved = { ...proposed, stage: to, updated: new Date().toISOString() };
    if (moved.flag === 'paused') moved.flag = null;
    items[index] = moved;
    ctx.store.writeItems(items);
    const queuedComment = Boolean(config.github?.enabled && current.gh && config.github?.comment_on_move);
    ctx.store.appendEvent({ type: 'move', item: id, from: current.stage, to, by: ctx.actor, evidence, ...(queuedComment ? { queued_comment: true } : {}) });
  });
}
