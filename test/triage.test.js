import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/triage.js';
import { isSchedulable } from '../lib/policy.js';
import { RuleError } from '../lib/cli/errors.js';

const stages = { stages: [{ id: 'icebox', role: 'initial' }, { id: 'shipped', role: 'done' }], terminal: ['shipped'], extra: [{ id: 'discarded', role: 'dropped' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'held', stage: 'icebox', flag: 'needs-triage', deps: [], ...over });
function board(stageConfig = stages) {
  const root = mkdtempSync(join(tmpdir(), 'gw-triage-')); const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify(stageConfig)); store.writeItems([item()]);
  return { root, store };
}
function ctx(b, flags) { return { store: b.store, root: b.root, positionals: ['P1-01'], flags, actor: 'human:lead', stdout: { write() {} } }; }

test('approve clears the hold, appends one flag event, and makes the item schedulable', () => {
  const b = board(); run(ctx(b, { approve: true }));
  const approved = b.store.readItems()[0];
  assert.equal(approved.flag, null);
  assert.equal(isSchedulable(approved, { config: {}, stages, items: [approved] }), true);
  assert.deepEqual(b.store.readEvents().map((event) => event.type), ['flag']);
});

test('drop uses the dropped role, writes one move event, and remains unschedulable', () => {
  const b = board(); run(ctx(b, { drop: true }));
  const dropped = b.store.readItems()[0];
  assert.equal(dropped.stage, 'discarded'); assert.equal(dropped.flag, null);
  assert.equal(isSchedulable(dropped, { config: {}, stages, items: [dropped] }), false);
  assert.deepEqual(b.store.readEvents().map((event) => event.type), ['move']);
});

test('triage refuses items that are not held and custom pipelines without a dropped role', () => {
  const b = board(); b.store.writeItems([item({ flag: null })]);
  assert.throws(() => run(ctx(b, { approve: true })), RuleError);
  const noDropped = board({ stages: [{ id: 'icebox' }, { id: 'shipped' }], terminal: ['shipped'] });
  assert.throws(() => run(ctx(noDropped, { drop: true })), /no dropped role/i);
});
