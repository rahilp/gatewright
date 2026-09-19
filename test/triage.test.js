import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/triage.js';
import { run as move } from '../lib/commands/move.js';
import { isSchedulable } from '../lib/policy.js';
import { RuleError } from '../lib/cli/errors.js';
import { runPrintedCommand } from './helpers/printed-command.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

const stages = { stages: [{ id: 'icebox', role: 'initial' }, { id: 'shipped', role: 'done' }], terminal: ['shipped'], extra: [{ id: 'discarded', role: 'dropped' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'held', stage: 'icebox', flag: 'needs-triage', deps: [], ...over });
function board(stageConfig = stages) {
  const root = mkdtempSync(join(tmpdir(), 'gw-triage-')); const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify(stageConfig)); store.writeItems([item()]);
  return { root, store };
}
function ctx(b, flags) { return { store: b.store, root: b.root, positionals: ['P1-01'], flags, actor: 'human:lead', stdout: { write() {} } }; }

test('a different agent approves an agent-created item, records the approver, and makes it schedulable', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:alpha' })]);
  run({ ...ctx(b, { approve: true }), actor: 'agent:beta' });
  const approved = b.store.readItems()[0];
  assert.equal(approved.flag, null);
  assert.equal(isSchedulable(approved, { config: {}, stages, items: [approved] }), true);
  assert.deepEqual(b.store.readEvents().map((event) => event.type), ['flag']);
  assert.equal(b.store.readEvents()[0].approved_by, 'agent:beta');
  assert.match(b.store.readEvents()[0].reason, /approved by agent:beta/);
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

test('an agent cannot approve its own item even with --force, but the printed drop command works', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:lead' })]);
  assert.throws(() => run({ ...ctx(b, { approve: true, force: true }), actor: 'agent:lead' }), (error) => {
    assert.match(error.message, /created by agent:lead/);
    assert.match(error.message, /ask a human or a different agent to approve it/);
    assert.match(error.message, /gw config policy\.triage_required_for none/);
    assert.match(error.message, /--force does not allow self-approval/);
    return error instanceof RuleError;
  });
  assert.equal(b.store.readItems()[0].flag, 'needs-triage', 'the hold survives the forced refusal');
  run({ ...ctx(b, { drop: true }), actor: 'agent:lead' });
  assert.equal(b.store.readItems()[0].stage, 'discarded', 'the exact printed drop route is usable by the creator');
});

// T-0095.1 — the test extracts the command from the refusal and sends its
// exact text through the platform shell (cmd.exe on Windows).
test('T-0095.1: the triage refusal advice turns off the policy hold in front of the creator', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-triage-advice-'));
  const gw = (args, actor) => execFileSync(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, ...(actor ? { GW_ACTOR: actor } : {}) },
    encoding: 'utf8',
  });

  gw(['init', '--yes', '--pipeline', 'team', '--no-hook']);
  assert.equal(gw(['add', 'held', '--scope', 's'], 'agent:a').trim(), 'T-0001');

  let refusal = '';
  assert.throws(
    () => gw(['triage', 'T-0001', '--approve'], 'agent:a'),
    (error) => { refusal = String(error.stderr); return true; },
  );
  const command = refusal.match(/`(gw config policy\.triage_required_for none)`/)?.[1];
  assert.equal(command, 'gw config policy.triage_required_for none', refusal);
  const result = runPrintedCommand(root, command, { ...process.env, GW_ACTOR: 'agent:a' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /released 1 triage hold no longer required by policy/);

  const store = createStore(root);
  assert.equal(store.readItems().find((candidate) => candidate.id === 'T-0001').flag, null);
  const release = store.readEvents().find((event) => event.item === 'T-0001' && event.reason === 'triage hold no longer required by policy');
  assert.equal(release.by, 'agent:a');
  assert.equal(release.policy_changed_by, 'agent:a');

  gw(['claim', 'T-0001'], 'agent:a');
  gw(['move', 'T-0001', 'building'], 'agent:a');
  assert.equal(store.readItems().find((candidate) => candidate.id === 'T-0001').stage, 'building');
});

test('a different agent and a human can both approve an agent-created item', () => {
  const otherAgent = board(); otherAgent.store.writeItems([item({ created_by: 'agent:gates' })]);
  run({ ...ctx(otherAgent, { approve: true }), actor: 'agent:reviewer' });
  assert.equal(otherAgent.store.readItems()[0].flag, null);

  const reviewer = board(); reviewer.store.writeItems([item({ created_by: 'agent:gates' })]);
  run({ ...ctx(reviewer, { approve: true }), actor: 'human:reviewer' });
  assert.equal(reviewer.store.readItems()[0].flag, null);
});

test('agent A creates, agent B approves, and the item then advances', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:a' })]);
  run({ ...ctx(b, { approve: true }), actor: 'agent:b' });
  move({ store: b.store, root: b.root, positionals: ['P1-01', 'shipped'], flags: {}, actor: 'agent:b', stdout: { write() {} } });
  assert.equal(b.store.readItems()[0].stage, 'shipped');
});

test('a detected Cursor Agent cannot approve through the default human identity', () => {
  const b = board(); b.store.writeItems([item({ created_by: 'agent:maker' })]);
  assert.throws(
    () => run({ ...ctx(b, { approve: true }), actor: 'human:maker', env: { CURSOR_AGENT: '1' } }),
    /Cursor Agent is present but GW_ACTOR is unset[\s\S]*GW_ACTOR=agent:<name>/,
  );
  assert.equal(b.store.readItems()[0].flag, 'needs-triage');
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
