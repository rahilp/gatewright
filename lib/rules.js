import { describeRule } from './gates/describe.js';

export function stageList(stages) {
  return [...(stages.stages ?? []), ...(stages.extra ?? [])];
}

export function stageIndex(stages, stageId) {
  return (stages.stages ?? []).findIndex((stage) => stage.id === stageId);
}

export function nextStage(stages, stageId) {
  const index = stageIndex(stages, stageId);
  if (index < 0) return null;
  return stages.stages[index + 1]?.id ?? null;
}

// Evidence entries are `{ text, stage }` (flat strings are the migrated
// pre-tagging shape, read in as `stage: null`). `evidenceText` accepts both,
// because events, imports and tests still carry strings.
export function evidenceText(entry) {
  const raw = typeof entry === 'string' ? entry : entry?.text;
  return typeof raw === 'string' ? raw.trim() : '';
}

// Which gate an entry may be counted toward. An entry counts for the stage it
// was supplied with — never for any other. Migrated `stage: null` entries were
// recorded under the old lifetime-array rule, so their justification is
// unknown: credit them to every gate at or before the stage the item already
// stands in, and to no gate the item is entering. Without that second clause a
// board upgraded mid-flight would sail the new gates on evidence recorded when
// they could not fail.
function entryCovers(entry, stageId, item, stages) {
  // A bare string entry (an item that reached the evaluator without a store
  // round-trip — imports, sync, direct callers) is the migrated shape: null.
  const entryStage = typeof entry === 'string' ? null : entry.stage ?? null;
  if (entryStage === stageId) return true;
  if (entryStage !== null) return false;
  const currentIndex = stageIndex(stages, item.stage);
  if (currentIndex < 0) return false;
  return stageIndex(stages, stageId) <= currentIndex;
}

// The evidence a gate may be judged on, after trimming and de-duplication.
// Duplicates inside one move count once, and an entry that repeats anything
// already recorded on the item — under any stage tag — is not fresh evidence:
// re-passing a gate (a forced backward move and re-entry) demands evidence the
// item did not already have. `supplied` is the item's pre-move evidence; it
// applies only to the stage this move is entering, never to the earlier gates
// cumulative evaluation replays, whose entries were fresh when their own move
// was accepted.
export function freshEvidence(item, stageId, { stages, supplied = null } = {}) {
  const prior = new Set((supplied ?? []).map(evidenceText).filter(Boolean));
  const seen = new Set();
  const fresh = [];
  for (const entry of item.evidence ?? []) {
    if (!entryCovers(entry, stageId, item, stages)) continue;
    const text = evidenceText(entry);
    if (!text || seen.has(text) || prior.has(text)) continue;
    seen.add(text);
    fresh.push(text);
  }
  return fresh;
}

export function evaluateRequires(item, targetStageId, { items = [], stages, supplied = null } = {}) {
  const target = stageList(stages).find((stage) => stage.id === targetStageId);
  const requires = target?.requires;
  if (!requires) return { ok: true, failures: [] };

  const failures = [];
  // A stage named "Specified" that asks for nothing is a stage that means
  // nothing: it is traversed in the same breath as claiming and building, and
  // the board reports a scoping step that never happened. `scope: true` is
  // what lets such a stage require the thing it is named after.
  if (requires.scope && !String(item.scope ?? '').trim()) {
    failures.push(`needs a scope: run \`gw edit ${item.id} --scope "<what done looks like>"\``);
  }
  if (requires.owner && !item.owner) {
    failures.push(`needs an owner: run \`gw claim ${item.id}\``);
  }

  const fresh = freshEvidence(item, targetStageId, { stages, supplied });

  if (requires.evidence_min && fresh.length < requires.evidence_min) {
    failures.push(
      `${describeRule('evidence_min', requires.evidence_min, stages)}: run \`gw move ${item.id} ${targetStageId} --evidence <e>\``,
    );
  }

  if (requires.evidence_match) {
    const regex = new RegExp(requires.evidence_match);
    if (!fresh.some((text) => regex.test(text))) {
      failures.push(
        `${describeRule('evidence_match', requires.evidence_match, stages)}: run \`gw move ${item.id} ${targetStageId} --evidence <e>\``,
      );
    }
  }

  if (requires.deps_at_least) {
    const boundary = stageIndex(stages, requires.deps_at_least);
    const byId = new Map(items.map((candidate) => [candidate.id, candidate]));
    const bad = (item.deps ?? []).filter((id) => {
      const dependency = byId.get(id);
      return !dependency || stageIndex(stages, dependency.stage) < boundary;
    });
    if (bad.length) {
      failures.push(
        `dependencies must be at least ${requires.deps_at_least}: ${bad.join(', ')}. Move them with \`gw move <id> ${requires.deps_at_least}\`.`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

// A pipeline position is a claim about every gate before it, not merely its
// own entry gate. Extras deliberately sit outside that claim.
export function evaluateCumulative(item, targetStageId, { items, stages, supplied = null } = {}) {
  const targetIndex = stageIndex(stages, targetStageId);
  if (targetIndex < 0) {
    return evaluateRequires(item, targetStageId, { items, stages });
  }

  const failures = [];
  const seen = new Set();
  for (const stage of (stages.stages ?? []).slice(0, targetIndex + 1)) {
    // The in-flight move's own evidence is passed only to the target stage's
    // gate: earlier gates are judged on the entries that earned them, which
    // were fresh when their move was accepted and must not be disqualified
    // for already being on the item.
    const verdict = evaluateRequires(item, stage.id, {
      items,
      stages,
      ...(stage.id === targetStageId ? { supplied } : {}),
    });
    for (const failure of verdict.failures) {
      if (!seen.has(failure)) {
        seen.add(failure);
        failures.push(`${stage.id}: ${failure}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

// The refusal a caller sees when a move is not a single step forward. Naming
// the exact command to run is what makes the message actionable instead of a
// dead end -- and "actionable" has a hard test: `move` must accept the command
// this sentence prints. It did not, twice, and both dead ends looped: the
// refusal named a command that this same function refused in the same words.
//
// The order of these branches is the fix. `next === null` used to be read as
// "outside the pipeline", which is true for a side stage and false for the
// last stage -- an item standing in the final stage of the pipeline was told
// it was not in the pipeline, and sent to a command that could not run.
export function stageOrderMessage(id, current, to, stages) {
  const fromIndex = stageIndex(stages, current);
  const toIndex = stageIndex(stages, to);
  const next = nextStage(stages, current);
  const forced = `run \`gw move ${id} ${to} --force\``;

  // A side stage (paused, dropped, anything in `extra`) has no position in the
  // pipeline, so nothing follows it and every pipeline target is a jump. That
  // is precisely what --force is for; sending the caller to the first stage
  // instead just refused them again, one stage to the left.
  if (fromIndex < 0) {
    return `${current} is outside the pipeline, so no stage follows it; re-entering at ${to} needs --force: ${forced}`;
  }

  // Backward, including every target from the last stage -- where the item is
  // in the pipeline, at the end of it, and everything else is behind it.
  if (toIndex >= 0 && toIndex < fromIndex) {
    return `${to} comes before ${current} in the pipeline; moving backward needs --force: ${forced}`;
  }

  // Forward from the last stage is not reachable -- nothing is ahead of it --
  // but a caller passing a stage this module cannot place still gets a command
  // that runs, rather than a sentence that leads nowhere.
  if (next === null) {
    return `nothing follows ${current} in the pipeline; moving to ${to} needs --force: ${forced}`;
  }

  // Stages beyond the immediate next stage that still have to be passed
  // through before `to` is reachable. The next stage itself is never
  // "skipped" -- it is the mandatory first hop -- so this only counts what
  // comes after it.
  const beyond = toIndex >= 0 ? toIndex - fromIndex - 2 : 0;
  const detail = beyond > 0 ? ` (${to} is ${beyond + 1} stages beyond ${next})` : '';
  return `${next}: move here first${detail}: run \`gw move ${id} ${next}\``;
}

export function missingDeps(items) {
  const ids = new Set(items.map((item) => item.id));
  return items
    .map((item) => ({
      id: item.id,
      missing: (item.deps ?? []).filter((dep) => !ids.has(dep)),
    }))
    .filter((entry) => entry.missing.length);
}

export function findCycles(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const state = new Map();
  const stack = [];
  const cycles = [];
  const found = new Set();

  function visit(id) {
    state.set(id, 1);
    stack.push(id);

    for (const dep of byId.get(id).deps ?? []) {
      if (!byId.has(dep)) continue;

      if (state.get(dep) === 1) {
        const cycle = stack.slice(stack.indexOf(dep));
        // Rotation is irrelevant: A → B → C is the same cycle as B → C → A.
        const key = [...cycle].sort().join('\0');
        if (!found.has(key)) {
          found.add(key);
          cycles.push(cycle);
        }
      } else if (!state.get(dep)) {
        visit(dep);
      }
    }

    stack.pop();
    state.set(id, 2);
  }

  for (const { id } of items) {
    if (!state.get(id)) visit(id);
  }

  return cycles;
}
