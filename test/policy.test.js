import test from 'node:test';
import assert from 'node:assert/strict';
import { isSchedulable } from '../lib/policy.js';

const stages = { stages: [{ id: 'backlog' }, { id: 'building', requires: { deps_at_least: 'building' } }, { id: 'done' }], terminal: ['done'] };
const item = (over = {}) => ({ id: 'P1-01', stage: 'backlog', flag: null, deps: [], ...over });

test('isSchedulable is total and holds every flagged, blocked, terminal, and dependency-blocked item', () => {
  assert.equal(isSchedulable(null, { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ flag: 'needs-triage' }), { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ flag: 'blocked' }), { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ flag: 'paused' }), { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ stage: 'done' }), { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ deps: ['missing'] }), { config: {}, stages, items: [] }), false);
  assert.equal(isSchedulable(item({ deps: ['P1-02'] }), { config: {}, stages, items: [item({ id: 'P1-02', stage: 'backlog' })] }), false);
});

test('isSchedulable admits an unheld non-terminal item when all dependencies meet its next gate', () => {
  const child = item({ deps: ['P1-02'] });
  const dep = item({ id: 'P1-02', stage: 'building' });
  assert.equal(isSchedulable(child, { config: {}, stages, items: [child, dep] }), true);
});
