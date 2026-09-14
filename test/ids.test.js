import test from 'node:test';
import assert from 'node:assert/strict';
import { nextId } from '../lib/ids.js';

test('nextId skips gaps, pads the tenth item, and numbers children', () => {
  assert.equal(nextId([{ id: 'P1-01' }, { id: 'P1-03' }], { phase: 'P1' }), 'P1-04');
  assert.equal(nextId([{ id: 'P1-09' }], { phase: 'P1' }), 'P1-10');
  assert.equal(nextId([], { phase: 'P1', parent: 'P1-01' }), 'P1-01.1');
  assert.equal(nextId(Array.from({ length: 10 }, (_, i) => ({ id: `P1-01.${i + 1}` })), { phase: 'P1', parent: 'P1-01' }), 'P1-01.11');
});

test('seq ids span the board, skip gaps, and number children', () => {
  assert.equal(nextId([], { scheme: 'seq' }), 'T-0001');
  assert.equal(nextId([{ id: 'T-0001' }], { scheme: 'seq' }), 'T-0002');
  assert.equal(nextId([{ id: 'T-0001' }, { id: 'T-0003' }], { scheme: 'seq' }), 'T-0004');
  assert.equal(nextId([], { scheme: 'seq', parent: 'T-0001' }), 'T-0001.1');
});

test('switching id schemes preserves existing namespaces', () => {
  const items = [{ id: 'P2-01' }, { id: 'P2-03' }, { id: 'T-0002' }];
  assert.equal(nextId(items, { scheme: 'seq' }), 'T-0003');
  assert.equal(nextId(items, { scheme: 'phase-seq', phase: 'P2' }), 'P2-04');
});

test('unknown id schemes are usage errors naming supported schemes', () => {
  assert.throws(() => nextId([], { scheme: 'random' }), (error) => error.name === 'Error' && /phase-seq, seq/.test(error.message) && error.exitCode === 2);
});
