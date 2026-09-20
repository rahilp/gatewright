import { nextStage, stageIndex } from './rules.js';
import { isTerminalStage } from './stages.js';

// The runner's single admission check. A malformed or partial item never starts work.
export function isSchedulable(item, { config = {}, stages = {}, items = [] } = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.flag != null || isTerminalStage(item.stage, stages)) return false;
  const deps = Array.isArray(item.deps) ? item.deps : [];
  // An item with no dependencies has nothing to look up, so nothing below it is
  // needed to answer. This used to be reached anyway, building a Map of the whole
  // board per call -- which made the scheduler's candidate filter cost
  // items x items per tick, the same shape of quadratic as the event walk T-0133
  // removed from lib/run/scheduler.js, and measurably the larger of the two once
  // that one was gone. The answer is unchanged: an empty `deps` satisfies
  // `every()` whatever the gate asks for.
  if (!deps.length) return true;
  const byId = new Map((Array.isArray(items) ? items : []).filter(Boolean).map((candidate) => [candidate.id, candidate]));
  const targetId = nextStage(stages, item.stage);
  const target = (stages.stages ?? []).find((stage) => stage.id === targetId);
  const boundary = target?.requires?.deps_at_least;
  return deps.every((id) => {
    const dependency = byId.get(id);
    return dependency && (!boundary || stageIndex(stages, dependency.stage) >= stageIndex(stages, boundary));
  });
}
