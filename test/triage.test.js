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

// T-0085 — agent-created work crosses a human review boundary. The immutable
// creator provenance, not a caller-supplied --force, decides whether it does.
test('an agent creator is refused approval even with --force, without a bypass hint', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:lead' })]);
  assert.throws(() => run({ ...ctx(b, { approve: true, force: true }), actor: 'agent:lead' }), (error) => {
    assert.match(error.message, /created by agent:lead/);
    assert.match(error.message, /different human approver/);
    assert.doesNotMatch(error.message, /--force/);
    return error instanceof RuleError;
  });
  assert.equal(b.store.readItems()[0].flag, 'needs-triage', 'the hold survives the forced refusal');
});

test('an agent-created item requires a different human, closing the omitted-GW_ACTOR alias', () => {
  const sameName = board(); sameName.store.writeItems([item({ created_by: 'agent:gates' })]);
  assert.throws(() => run({ ...ctx(sameName, { approve: true }), actor: 'human:gates' }), /different human approver/, 'human:gates is the fallback alias for agent:gates, not a reviewer');

  const otherAgent = board(); otherAgent.store.writeItems([item({ created_by: 'agent:gates' })]);
  assert.throws(() => run({ ...ctx(otherAgent, { approve: true }), actor: 'agent:reviewer' }), /different human approver/, 'an agent-created item needs a human review boundary, not another agent');

  const reviewer = board(); reviewer.store.writeItems([item({ created_by: 'agent:gates' })]);
  run({ ...ctx(reviewer, { approve: true }), actor: 'human:reviewer' });
  assert.equal(reviewer.store.readItems()[0].flag, null);
});

test('a human creator succeeds without --force', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'human:lead' })]);
  run(ctx(b, { approve: true }));
  assert.equal(b.store.readItems()[0].flag, null);
});

test('the creator may still drop their own held item', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'human:lead' })]);
  run(ctx(b, { drop: true }));
  assert.equal(b.store.readItems()[0].flag, null);
});
