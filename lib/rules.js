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

export function evaluateRequires(item, targetStageId, { items, stages }) {
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

  if (
    requires.evidence_min
    && (item.evidence ?? []).length < requires.evidence_min
  ) {
    const plural = requires.evidence_min === 1 ? 'y' : 'ies';
    failures.push(
      `needs at least ${requires.evidence_min} evidence entr${plural}: run \`gw move ${item.id} ${targetStageId} --evidence <e>\``,
    );
  }

  if (requires.evidence_match) {
    const regex = new RegExp(requires.evidence_match);
    if (!(item.evidence ?? []).some((evidence) => regex.test(evidence))) {
      failures.push(
        `needs matching evidence: run \`gw move ${item.id} ${targetStageId} --evidence <e>\``,
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
export function evaluateCumulative(item, targetStageId, { items, stages }) {
  const targetIndex = stageIndex(stages, targetStageId);
  if (targetIndex < 0) {
    return evaluateRequires(item, targetStageId, { items, stages });
  }

  const failures = [];
  const seen = new Set();
  for (const stage of (stages.stages ?? []).slice(0, targetIndex + 1)) {
    const verdict = evaluateRequires(item, stage.id, { items, stages });
    for (const failure of verdict.failures) {
      if (!seen.has(failure)) {
        seen.add(failure);
        failures.push(`${stage.id}: ${failure}`);
      }
    }
  }
  return { ok: failures.length === 0, failures };
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
