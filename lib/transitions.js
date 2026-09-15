import { evaluateCumulative, evaluateRequires, nextStage, stageIndex, stageList } from './rules.js';
import { describeRule } from './gates/describe.js';

// Rewriting a stage's `requires` down to a single rule, leaving every other
// stage (and the pipeline order deps_at_least reads) untouched.
function isolateRule(stages, stageId, key, value) {
  const only = (list) => (list ?? []).map((stage) => (stage.id === stageId ? { ...stage, requires: { [key]: value } } : stage));
  return { ...stages, stages: only(stages.stages), extra: only(stages.extra) };
}

// Which rules a refused move actually failed, in the same English the Stages
// view uses. `failures` stays exactly as lib/rules.js phrases it -- it carries
// the command to run and the ids at fault -- but a human dropping a card needs
// the condition, not the shell line. Each rule is put to the real evaluator on
// its own rather than re-derived here: a second evaluator is how a board
// starts announcing rules it does not enforce.
export function unmetReasons(item, targetStageId, { items, stages }) {
  const targetIndex = stageIndex(stages, targetStageId);
  const scope = targetIndex < 0
    ? stageList(stages).filter((stage) => stage.id === targetStageId)
    : (stages.stages ?? []).slice(0, targetIndex + 1);
  const reasons = [];
  for (const stage of scope) {
    for (const [key, value] of Object.entries(stage.requires ?? {})) {
      if (evaluateRequires(item, stage.id, { items, stages: isolateRule(stages, stage.id, key, value) }).ok) continue;
      const sentence = describeRule(key, value, stages);
      if (sentence && !reasons.includes(sentence)) reasons.push(sentence);
    }
  }
  return reasons;
}

// The single source of truth for "what can this item do next", shared by the
// live board's `/api/items/<id>/transitions` endpoint and `gw next`. Keep the
// decision here rather than maintaining a second evaluator per surface.
export function transitionsFor(item, items, stages) {
  const terminal = (stages.terminal ?? []).includes(item.stage);
  const next = nextStage(stages, item.stage);
  const transitions = {};

  for (const target of stageList(stages)) {
    if (target.id === item.stage) continue;
    const sideStage = stageIndex(stages, target.id) < 0;

    // A terminal item can only leave through a side stage, and that departure
    // requires --force. Pipeline jumps are rejected even when forced.
    if (terminal && !sideStage) continue;

    const force = terminal || (!sideStage && target.id !== next);
    const verdict = evaluateCumulative(item, target.id, { items, stages });
    transitions[target.id] = {
      ok: verdict.ok,
      failures: verdict.failures,
      ...(verdict.ok ? {} : { reasons: unmetReasons(item, target.id, { items, stages }) }),
      ...(force ? { force: true } : {}),
    };
  }
  return transitions;
}
