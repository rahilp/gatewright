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
