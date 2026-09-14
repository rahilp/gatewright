import test from 'node:test';
import assert from 'node:assert/strict';
import { stageList, stageIndex, nextStage, evaluateRequires, findCycles, missingDeps } from '../lib/rules.js';

const stages = { stages: [
  { id: 'backlog' }, { id: 'building', requires: { owner: true } },
  { id: 'built', requires: { evidence_min: 1, deps_at_least: 'built' } },
  { id: 'review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
], terminal: ['dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
const item = (overrides = {}) => ({ id: 'A', stage: 'backlog', owner: null, evidence: [], deps: [], ...overrides });

test('stage helpers preserve pipeline order and exclude extras from indexing', () => {
  assert.deepEqual(stageList(stages).map((stage) => stage.id), ['backlog', 'building', 'built', 'review', 'dropped', 'paused']);
  assert.equal(stageIndex(stages, 'built'), 2);
  assert.equal(stageIndex(stages, 'dropped'), -1);
  assert.equal(nextStage(stages, 'built'), 'review');
  assert.equal(nextStage(stages, 'review'), null);
});

test('owner, evidence minimum, and evidence pattern requirements pass and fail', () => {
  assert.equal(evaluateRequires(item({ owner: 'human:a' }), 'building', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item(), 'building', { items: [], stages }).failures[0], /gw claim A/);
  assert.equal(evaluateRequires(item({ evidence: ['commit'] }), 'built', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item(), 'built', { items: [], stages }).failures.join('\n'), /evidence/);
  assert.equal(evaluateRequires(item({ evidence: ['https://github.com/a/b/pull/1'] }), 'review', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item({ evidence: ['commit'] }), 'review', { items: [], stages }).failures[0], /evidence/);
});

test('dependency stage requirement accepts its boundary and rejects earlier, missing, and extra stages', () => {
  const subject = item({ evidence: ['commit'], deps: ['B'] });
  assert.equal(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'built' })], stages }).ok, true);
  assert.match(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'building' })], stages }).failures[0], /B/);
  assert.match(evaluateRequires(item({ evidence: ['commit'], deps: ['X'] }), 'built', { items: [], stages }).failures[0], /X/);
  assert.match(evaluateRequires(item({ evidence: ['commit'], deps: ['D'] }), 'built', { items: [item({ id: 'D', stage: 'dropped' })], stages }).failures[0], /D/);
});

test('a stage without requirements passes', () => assert.deepEqual(evaluateRequires(item(), 'backlog', { items: [], stages }), { ok: true, failures: [] }));

test('findCycles deterministically finds self, two-item, and three-item cycles', () => {
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['A'] })]), [['A']]);
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['B'] }), item({ id: 'B', deps: ['A'] })]), [['A', 'B']]);
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['B'] }), item({ id: 'B', deps: ['C'] }), item({ id: 'C', deps: ['A'] })]), [['A', 'B', 'C']]);
});

test('missingDeps lists missing ids by item', () => {
  assert.deepEqual(missingDeps([item({ id: 'A', deps: ['B', 'X'] }), item({ id: 'B' })]), [{ id: 'A', missing: ['X'] }]);
});
