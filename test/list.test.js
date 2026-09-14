import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const items = [
  { id: 'P1-01', title: 'First', phase: 'P1', stage: 'backlog', flag: null },
  { id: 'P2-02', title: 'Second', phase: 'P2', stage: 'building', flag: 'blocked' },
];
function board() { const root = mkdtempSync(join(tmpdir(), 'gw-list-')); const store = createStore(root); store.ensure(); store.writeItems(items); return { root, store }; }

test('list filters and json returns an array', () => {
  const { root } = board();
  assert.match(execFileSync(process.execPath, [BIN, 'list', '--stage', 'building'], { cwd: root, encoding: 'utf8' }), /P2-02.*Second/);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [BIN, 'list', '--flag', 'blocked', '--json'], { cwd: root, encoding: 'utf8' })), [items[1]]);
});

test('list is read-only byte-for-byte', () => {
  const { root, store } = board(); const before = [store.paths.items, store.paths.events, store.paths.digest].map((p) => readFileSync(p));
  execFileSync(process.execPath, [BIN, 'list'], { cwd: root });
  assert.deepEqual([store.paths.items, store.paths.events, store.paths.digest].map((p) => readFileSync(p)), before);
});
