import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/add.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo(config = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-add-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), JSON.stringify({ vocab: { phase: ['P1', 'P2'] }, policy: {}, ...config })); const store = createStore(root); store.ensure(); return { root, store }; }

test('add creates a fully defaulted item and exactly one add event', () => {
  const { store } = repo(); let out = ''; const id = run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['hello'], stdout: { write: s => { out += s; } } });
  assert.equal(id, undefined); assert.equal(out, 'P1-01\n');
  const item = store.readItems()[0]; assert.equal(item.id, 'P1-01'); assert.equal(item.stage, 'backlog'); assert.equal(item.created_by, 'human'); assert.equal(item.owner, null); assert.deepEqual(item.deps, []); assert.deepEqual(item.refs, []); assert.equal(store.readEvents().length, 1); assert.equal(store.readEvents()[0].type, 'add');
});

test('seq config produces board-wide ids and children', () => {
  const { root } = repo({ id_scheme: 'seq', vocab: {} });
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'first'], { cwd: root, encoding: 'utf8' }), 'T-0001\n');
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'second'], { cwd: root, encoding: 'utf8' }), 'T-0002\n');
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'child', '--parent', 'T-0001'], { cwd: root, encoding: 'utf8' }), 'T-0001.1\n');
});

test('phase-seq refuses a missing phase through the real binary', () => {
  const { root } = repo({ vocab: null });
  const result = spawnSync(process.execPath, [BIN, 'add', 'no phase'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass --phase/);
  assert.match(result.stderr, /configure vocab\.phase/);
  assert.match(result.stderr, /id_scheme.*seq/);
});

test('seq remains usable without vocabulary on the same board shape', () => {
  const { root } = repo({ id_scheme: 'seq', vocab: null });
  const result = spawnSync(process.execPath, [BIN, 'add', 'no phase needed'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'T-0001\n');
});

test('add uses the custom pipeline initial stage', () => {
  const { root, store } = repo();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'icebox', label: 'Icebox' }, { id: 'building', label: 'Building' }], terminal: [] }));
  const result = spawnSync(process.execPath, [BIN, 'add', 'custom stage item'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(store.readItems()[0].stage, 'icebox');
});

test('add defaults phase from vocabulary, or null without vocabulary', () => {
  const configured = repo({ vocab: { phase: ['Discovery', 'Delivery'] } });
  run({ store: configured.store, root: configured.root, actor: 'human:me', flags: {}, positionals: ['configured'], stdout: { write() {} } });
  assert.equal(configured.store.readItems()[0].phase, 'Discovery');

  const unconfigured = repo({ id_scheme: 'seq', vocab: null });
  run({ store: unconfigured.store, root: unconfigured.root, actor: 'human:me', flags: {}, positionals: ['unconfigured'], stdout: { write() {} } });
  assert.equal(unconfigured.store.readItems()[0].phase, null);
});

test('unknown id scheme exits 2 through the real binary', () => {
  const { root } = repo({ id_scheme: 'bogus' });
  const result = spawnSync(process.execPath, [BIN, 'add', 'bad'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /phase-seq, seq/);
});

test('add through the real binary prints only the new id', () => {
  const { root } = repo(); const out = execFileSync(process.execPath, [BIN, 'add', 'binary item', '--phase', 'P2', '--by', 'agent:r1'], { cwd: root, encoding: 'utf8' }); assert.equal(out, 'P2-01\n');
});

test('agent child policy and vocabulary validation are enforced', () => {
  const { store } = repo({ vocab: { phase: ['P1'], type: ['feature'] }, policy: { max_children_per_item: 0, triage_required_for: ['agent'], auto_dispatch_children: false } }); store.writeItems([{ id: 'P1-01', parent: null }]);
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'P1-01', phase: 'P1', type: 'feature' }, positionals: ['child'], stdout: { write() {} } }), /children/i);
  assert.throws(() => run({ store, root: store.root, actor: 'human:x', flags: { phase: 'P9' }, positionals: ['bad'], stdout: { write() {} } }), /P1/);
});

test('add uses the shared vocabulary validation message', () => {
  const { store } = repo({ vocab: { type: ['feature'] } });
  assert.throws(
    () => run({ store, root: store.root, actor: 'human:x', flags: { type: 'defect' }, positionals: ['bad'], stdout: { write() {} } }),
    /invalid --type 'defect'; allowed values: feature/,
  );
});
