import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
