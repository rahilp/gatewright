const ROLE_NAMES = new Set(['initial', 'done', 'dropped', 'paused']);

function pipeline(stages) {
  return stages.stages ?? [];
}

function allStages(stages) {
  return [...pipeline(stages), ...(stages.extra ?? [])];
}

// Resolve the semantic names consumers use without making the process depend
// on Gatewright's shipped stage IDs.
export function resolveRoles(stages) {
  const listed = allStages(stages);
  const explicit = new Map(listed
    .filter((stage) => ROLE_NAMES.has(stage.role))
    .map((stage) => [stage.role, stage.id]));
  const flow = pipeline(stages);

  return {
    initial: explicit.get('initial') ?? flow[0]?.id ?? null,
    done: explicit.get('done') ?? flow.at(-1)?.id ?? null,
    dropped: explicit.get('dropped') ?? listed.find((stage) => stage.id === 'dropped')?.id ?? null,
    paused: explicit.get('paused') ?? listed.find((stage) => stage.id === 'paused')?.id ?? null,
  };
}

export function isDropped(item, roles) {
  return roles.dropped !== null && item.stage === roles.dropped;
}

// A stage that declares `role: "done"` is the finish line, so work standing
// there is finished and must not be reported as still in flight. Only an
// EXPLICIT role counts here, never the one resolveRoles infers from "last
// stage in the pipeline": inferring it would silently reclassify the final
// stage of every existing board, including pipelines whose last stage is a
// real waiting room rather than an ending. Opting in is a one-line change to
// stages.json; being opted in without asking is a board that quietly changes
// what it claims.
export function isTerminalStage(stageId, stages, roles = resolveRoles(stages)) {
  if ((stages.terminal ?? []).includes(stageId) || stageId === roles.dropped) return true;
  return allStages(stages).some((stage) => stage.id === stageId && stage.role === 'done');
}

export function validateStages(stages) {
  const findings = [];
  const flow = pipeline(stages);
  const listed = allStages(stages);
  const ids = new Set();
  const roles = new Map();

  if (!flow.length) findings.push('pipeline: add at least one stage to stages.');

  for (const stage of listed) {
    const name = stage.id ?? '<unnamed>';
    if (ids.has(stage.id)) findings.push(`stage ${name}: duplicate stage id; rename one of the stages.`);
    ids.add(stage.id);

    if (stage.role !== undefined) {
      if (!ROLE_NAMES.has(stage.role)) {
        findings.push(`stage ${name}: role ${JSON.stringify(stage.role)} is invalid; use initial, done, dropped, or paused.`);
      } else if (roles.has(stage.role)) {
        findings.push(`stage ${name}: role ${stage.role} is already claimed by stage ${roles.get(stage.role)}; remove or change one role.`);
      } else {
        roles.set(stage.role, name);
      }
    }

    const requires = stage.requires ?? {};
    if (requires.deps_at_least !== undefined && !flow.some((candidate) => candidate.id === requires.deps_at_least)) {
      findings.push(`stage ${name}: requires.deps_at_least names ${JSON.stringify(requires.deps_at_least)}, which is not in the pipeline; use a pipeline stage id.`);
    }
    if (requires.evidence_match !== undefined) {
      try {
        new RegExp(requires.evidence_match);
      } catch {
        findings.push(`stage ${name}: requires.evidence_match is not a valid regular expression; correct the pattern.`);
      }
    }
  }

  for (const stageId of stages.terminal ?? []) {
    if (!ids.has(stageId)) findings.push(`terminal ${JSON.stringify(stageId)} does not name a stage; add that stage or remove it from terminal.`);
  }

  return findings;
}
