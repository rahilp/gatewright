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

// T-0036 — needs-triage exists to hold unreviewed agent-created work until
// someone else looks at it. Letting the approving actor be the item's own
// creator gates no one: the agent approves its own work. So the creator is
// refused and a different actor succeeds — by identity, not by string, since
// a bare `--by rahil` and a default `human:rahil` are the same person.
test('the creator cannot approve their own held item, and the refusal says who must', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'human:lead' })]);
  assert.throws(() => run(ctx(b, { approve: true })), (error) => {
    assert.match(error.message, /created by human:lead/);
    assert.match(error.message, /someone else|Another actor/);
    assert.match(error.message, /--force/);
    return error instanceof RuleError;
  });
  assert.equal(b.store.readItems()[0].flag, 'needs-triage', 'the hold survives the refusal');
});

test('a qualified default actor and a bare --by name are the same creator', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'lead' })]);
  assert.throws(() => run(ctx(b, { approve: true })), /created by lead/, 'the default human:<name> actor is the same person as a bare --by name');

  const agentBoard = board(); agentBoard.store.writeItems([item({ created_by: 'agent:gates' })]);
  assert.throws(() => run({ ...ctx(agentBoard, { approve: true }), actor: 'gates' }), /created by agent:gates/, 'a bare name matches its agent: qualified creator');
  run({ ...ctx(agentBoard, { approve: true }), actor: 'human:gates' });
  assert.equal(agentBoard.store.readItems()[0].flag, null, 'same name, different kind: provenance is the point of the prefix, so a human namesake may approve');
});

test('a different actor approves the held item, and --force is the deliberate override', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:gates' })]);
  run(ctx(b, { approve: true }));
  assert.equal(b.store.readItems()[0].flag, null, 'the actor who did not create the item lifts the hold');

  const forced = board(); forced.store.writeItems([item({ created_by: 'human:lead' })]);
  run(ctx(forced, { approve: true, force: true }));
  assert.equal(forced.store.readItems()[0].flag, null, '--force is the documented override for the creator');
});

test('the creator may still drop their own held item', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'human:lead' })]);
  run(ctx(b, { drop: true }));
  assert.equal(b.store.readItems()[0].flag, null);
});
