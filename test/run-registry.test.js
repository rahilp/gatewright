import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';

function board() {
  const root = mkdtempSync(join(tmpdir(), 'gw-run-registry-'));
  const store = createStore(root); store.ensure();
  store.writeItems([{ id: 'P1-01', owner: 'agent:r-dead', updated: '2026-01-01T00:00:00.000Z' }]);
  return { root, store, registry: createRunRegistry({ store }) };
}

test('dead run reconciliation ends the run, releases its item, and removes the record', () => {
  const { store, registry } = board();
  registry.record({ run: 'r-dead', item: 'P1-01', pid: 99999999, provider: 'fixture', worktree: '/worktree', log: '/log' });
  const result = registry.reconcile();
  assert.equal(result.cleaned.length, 1);
  assert.equal(store.readItems()[0].owner, null);
  assert.deepEqual(store.readEvents().map(({ ts, ...event }) => event), [{ type: 'run_ended', item: 'P1-01', run: 'r-dead', outcome: 'error', by: 'agent:r-dead' }]);
  assert.deepEqual(registry.list().records, []);
});

test('a live pid remains recorded and does not alter the item', () => {
  const { store, registry } = board();
  registry.record({ run: 'r-live', item: 'P1-01', pid: process.pid, provider: 'fixture', worktree: '/worktree', log: '/log' });
  const result = registry.reconcile();
  assert.deepEqual(result.cleaned, []);
  assert.equal(registry.list().records[0].run, 'r-live');
  assert.equal(store.readItems()[0].owner, 'agent:r-dead');
  assert.deepEqual(store.readEvents(), []);
});

test('malformed run records are reported and skipped without crashing reconciliation', () => {
  const { store, registry } = board();
  registry.record({ run: 'r-live', item: 'P1-01', pid: process.pid, provider: 'fixture', worktree: '/worktree', log: '/log' });
  writeFileSync(join(store.dir, 'runs', 'truncated.json'), '{"run":');
  const result = registry.reconcile();
  assert.equal(result.malformed.length, 1);
  assert.match(result.malformed[0], /truncated\.json$/);
  assert.equal(registry.list().records[0].run, 'r-live');
});
