import test from 'node:test';
import assert from 'node:assert/strict';
import { nextId } from '../lib/ids.js';

test('nextId skips gaps, pads the tenth item, and numbers children', () => {
  assert.equal(nextId([{ id: 'P1-01' }, { id: 'P1-03' }], { phase: 'P1' }), 'P1-04');
  assert.equal(nextId([{ id: 'P1-09' }], { phase: 'P1' }), 'P1-10');
  assert.equal(nextId([], { phase: 'P1', parent: 'P1-01' }), 'P1-01.1');
  assert.equal(nextId(Array.from({ length: 10 }, (_, i) => ({ id: `P1-01.${i + 1}` })), { phase: 'P1', parent: 'P1-01' }), 'P1-01.11');
});
