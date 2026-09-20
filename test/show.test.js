import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const item = { id: 'P1-01', title: 'Show me', phase: 'P1', stage: 'building', flag: null, owner: 'human:rahil', deps: [], evidence: [], notes: '', parent: null };
function board() { const root = mkdtempSync(join(tmpdir(), 'gw-show-')); const store = createStore(root); store.ensure(); store.writeItems([item]); writeFileSync(store.paths.events, JSON.stringify({ type: 'claim', item: item.id, by: item.owner }) + '\n'); return { root, store }; }

test('show prints every item field and its events; json is the raw item', () => {
  const { root } = board();
  const text = execFileSync(process.execPath, [BIN, 'show', item.id], { cwd: root, encoding: 'utf8' });
  for (const key of Object.keys(item)) assert.match(text, new RegExp(`^${key}:`, 'm'));
  assert.match(text, /claim/);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [BIN, 'show', item.id, '--json'], { cwd: root, encoding: 'utf8' })), item);
});

test('show is read-only byte-for-byte', () => {
  const { root, store } = board(); const before = [store.paths.items, store.paths.events, store.paths.digest].map((p) => readFileSync(p));
  execFileSync(process.execPath, [BIN, 'show', item.id], { cwd: root });
  const after = [store.paths.items, store.paths.events, store.paths.digest].map((p) => readFileSync(p));
  assert.deepEqual(after, before);
});

// T-0138 — the block printed `phase: null` on one line and `scope: ` on the
// next: two spellings of the same absence, one of them raw JSON. One dash
// means "nothing here", everywhere in the block.
test('every unset field renders the same way, and no raw null reaches the reader', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-show-unset-'));
  const store = createStore(root); store.ensure();
  store.writeItems([{ id: 'P1-02', title: 'Sparse', phase: null, scope: '', priority: null, deps: [], evidence: [], notes: '', owner: null, stage: 'backlog', flag: null, parent: null }]);
  const text = execFileSync(process.execPath, [BIN, 'show', 'P1-02'], { cwd: root, encoding: 'utf8' });
  for (const field of ['phase', 'scope', 'priority', 'deps', 'evidence', 'notes', 'owner', 'flag', 'parent']) {
    assert.match(text, new RegExp(`^${field}: \u2014$`, 'm'), `${field}\n${text}`);
  }
  assert.doesNotMatch(text, /: null$/m);
  assert.doesNotMatch(text, /: \[\]$/m);
  assert.doesNotMatch(text, /^\w+: $/m);
  // The fields that do carry something are untouched.
  assert.match(text, /^id: P1-02$/m);
  assert.match(text, /^title: Sparse$/m);
  assert.match(text, /^stage: backlog$/m);
  rmSync(root, { recursive: true, force: true });
});

// --json is what scripts parse: a dash is a rendering, not data.
test('--json still carries the raw nulls and empty strings', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-show-json-'));
  const store = createStore(root); store.ensure();
  const sparse = { id: 'P1-02', title: 'Sparse', phase: null, scope: '', deps: [], stage: 'backlog' };
  store.writeItems([sparse]);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [BIN, 'show', 'P1-02', '--json'], { cwd: root, encoding: 'utf8' })), sparse);
  rmSync(root, { recursive: true, force: true });
});

// A field whose value is 0 or false is a value, not an absence.
test('zero and false keep their own spelling', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-show-falsy-'));
  const store = createStore(root); store.ensure();
  store.writeItems([{ id: 'P1-03', title: 'Falsy', stage: 'backlog', attempts: 0, dispatched: false }]);
  const text = execFileSync(process.execPath, [BIN, 'show', 'P1-03'], { cwd: root, encoding: 'utf8' });
  assert.match(text, /^attempts: 0$/m);
  assert.match(text, /^dispatched: false$/m);
  rmSync(root, { recursive: true, force: true });
});
