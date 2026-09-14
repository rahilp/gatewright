import { nextStage, stageIndex } from './rules.js';
import { isTerminalStage } from './stages.js';

// The runner's single admission check. A malformed or partial item never starts work.
export function isSchedulable(item, { config = {}, stages = {}, items = [] } = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.flag != null || isTerminalStage(item.stage, stages)) return false;
  const byId = new Map((Array.isArray(items) ? items : []).filter(Boolean).map((candidate) => [candidate.id, candidate]));
  const targetId = nextStage(stages, item.stage);
  const target = (stages.stages ?? []).find((stage) => stage.id === targetId);
  const boundary = target?.requires?.deps_at_least;
  return (Array.isArray(item.deps) ? item.deps : []).every((id) => {
    const dependency = byId.get(id);
    return dependency && (!boundary || stageIndex(stages, dependency.stage) >= stageIndex(stages, boundary));
  });
}
