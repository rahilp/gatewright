import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoles, isDropped, isTerminalStage, validateStages } from '../lib/stages.js';
import shipped from '../templates/stages.json' with { type: 'json' };

test('shipped stages retain their role defaults without a migration', () => {
  assert.deepEqual(resolveRoles(shipped), { initial: 'backlog', done: 'verified', dropped: 'dropped', paused: 'paused' });
});

test('an explicit role overrides a positional default', () => {
  assert.equal(resolveRoles({ stages: [{ id: 'first' }, { id: 'start-here', role: 'initial' }, { id: 'last' }] }).initial, 'start-here');
});

test('custom pipelines resolve roles and allow absent optional roles', () => {
  const stages = { stages: [{ id: 'icebox' }, { id: 'speccing' }, { id: 'coding' }, { id: 'shipped' }], extra: [{ id: 'binned', role: 'dropped' }] };
  const roles = resolveRoles(stages);
  assert.deepEqual(roles, { initial: 'icebox', done: 'shipped', dropped: 'binned', paused: null });
  assert.equal(isDropped({ stage: 'binned' }, roles), true);
  assert.equal(isTerminalStage('binned', stages, roles), true);
  assert.equal(isTerminalStage('coding', stages, roles), false);
});

test('validateStages reports every malformed process-definition finding', () => {
  const findings = validateStages({
    stages: [
      { id: 'one', role: 'unknown', requires: { deps_at_least: 'side', evidence_match: '[' } },
      { id: 'one', role: 'initial' },
      { id: 'two', role: 'initial' },
    ],
    terminal: ['missing'],
    extra: [{ id: 'side' }],
  });
  assert.equal(findings.length, 6);
  assert.match(findings.join('\n'), /stage one: role "unknown" is invalid/);
  assert.match(findings.join('\n'), /duplicate stage id/);
  assert.match(findings.join('\n'), /role initial is already claimed/);
  assert.match(findings.join('\n'), /deps_at_least names "side".*not in the pipeline/);
  assert.match(findings.join('\n'), /evidence_match is not a valid regular expression/);
  assert.match(findings.join('\n'), /terminal "missing" does not name a stage/);
});

test('validateStages catches an empty pipeline and accepts a valid definition', () => {
  assert.match(validateStages({ stages: [], extra: [] })[0], /add at least one stage/);
  assert.deepEqual(validateStages({ stages: [{ id: 'queued', role: 'initial' }, { id: 'shipped', role: 'done', requires: { evidence_match: '^ok$' } }], terminal: ['shipped'], extra: [{ id: 'binned', role: 'dropped' }] }), []);
});

// A pipeline that ends at `built` -- the shape a repo that commits to main
// actually uses -- must be able to say so, or every finished item is counted
// as still in flight forever and `gw brief` degrades into a list of
// everything ever completed.
test('a stage that declares role done is terminal without being listed in terminal', () => {
  const trunk = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }], extra: [{ id: 'dropped' }] };
  assert.equal(isTerminalStage('built', trunk), true);
  assert.equal(isTerminalStage('building', trunk), false);
});

// The inferred default must NOT be treated as an ending. resolveRoles falls
// back to "last stage in the pipeline", and promoting that to terminal would
// silently reclassify the final stage of every board already in existence --
// including pipelines whose last stage is a waiting room, not a finish line.
test('the inferred done role does not make the last pipeline stage terminal', () => {
  const pipeline = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'awaiting_release' }] };
  assert.equal(resolveRoles(pipeline).done, 'awaiting_release', 'it is still reported as the done role');
  assert.equal(isTerminalStage('awaiting_release', pipeline), false, 'but inferring it never ends an item');
});

test('the shipped pipeline is unchanged by the role rule', () => {
  assert.equal(isTerminalStage('verified', shipped), true);
  assert.equal(isTerminalStage('built', shipped), false);
});

// A stage named "Built" that lets a claim of completion through with no scope
// means nothing: rigor belongs at the evidence gate, where completion is
// actually claimed, not at capture. `built` carries scope alongside evidence.
test('the shipped built stage requires the scope it is named after, alongside evidence', async () => {
  const { evaluateRequires } = await import('../lib/rules.js');
  const stages = shipped;
  const evidence = [{ text: 'e1', stage: 'built' }];
  const unscoped = evaluateRequires({ id: 'T-0001', scope: '', owner: null, deps: [], evidence }, 'built', { items: [], stages });
  assert.equal(unscoped.ok, false);
  assert.match(unscoped.failures[0], /needs a scope: run `gw edit T-0001 --scope/);

  const scoped = evaluateRequires({ id: 'T-0001', scope: 'what done looks like', owner: null, deps: [], evidence }, 'built', { items: [], stages });
  assert.equal(scoped.ok, true);

  // Whitespace is not a scope.
  const blank = evaluateRequires({ id: 'T-0001', scope: '   \n ', owner: null, deps: [], evidence }, 'built', { items: [], stages });
  assert.equal(blank.ok, false);

  // Scope alone is not enough either: built still needs evidence.
  const noEvidence = evaluateRequires({ id: 'T-0001', scope: 'what done looks like', owner: null, deps: [], evidence: [] }, 'built', { items: [], stages });
  assert.equal(noEvidence.ok, false);
  assert.match(noEvidence.failures[0], /Needs at least one new piece of evidence/);
});
