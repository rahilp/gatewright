import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/add.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo(config = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-add-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), JSON.stringify({ vocab: {}, policy: {}, ...config })); const store = createStore(root); store.ensure(); return { root, store }; }

test('add creates a fully defaulted item and exactly one add event', () => {
  const { store } = repo(); let out = ''; const id = run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['hello'], stdout: { write: s => { out += s; } } });
  assert.equal(id, undefined); assert.equal(out, 'P1-01\n');
  const item = store.readItems()[0]; assert.equal(item.id, 'P1-01'); assert.equal(item.stage, 'backlog'); assert.equal(item.created_by, 'human'); assert.equal(item.owner, null); assert.deepEqual(item.deps, []); assert.deepEqual(item.refs, []); assert.equal(store.readEvents().length, 1); assert.equal(store.readEvents()[0].type, 'add');
});

test('add through the real binary prints only the new id', () => {
  const { root } = repo(); const out = execFileSync(process.execPath, [BIN, 'add', 'binary item', '--phase', 'P2', '--by', 'agent:r1'], { cwd: root, encoding: 'utf8' }); assert.equal(out, 'P2-01\n');
});

test('agent child policy and vocabulary validation are enforced', () => {
  const { store } = repo({ vocab: { phase: ['P1'], type: ['feature'] }, policy: { max_children_per_item: 0, triage_required_for: ['agent'], auto_dispatch_children: false } }); store.writeItems([{ id: 'P1-01', parent: null }]);
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'P1-01', phase: 'P1', type: 'feature' }, positionals: ['child'], stdout: { write() {} } }), /children/i);
  assert.throws(() => run({ store, root: store.root, actor: 'human:x', flags: { phase: 'P9' }, positionals: ['bad'], stdout: { write() {} } }), /P1/);
});
