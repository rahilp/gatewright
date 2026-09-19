import './helpers/isolate-env.js';
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

// T-0044 — `--stage bogus` used to filter to zero rows and exit 0,
// indistinguishable from an empty stage. `move` refuses an unknown stage at
// exit 2; list gives the same answer, naming the stages that do exist.
test('an unknown stage is refused with the valid stages named', () => {
  const { root } = board();
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'list', '--stage', 'bogus'], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 2
      && /unknown stage: bogus; valid stages: .*backlog.*building.*dropped/.test(error.stderr),
  );
  assert.match(execFileSync(process.execPath, [BIN, 'list', '--stage', 'dropped'], { cwd: root, encoding: 'utf8' }), /^$/);
});

// T-0009 — a newline title once rendered as two rows, the second with no id
// or stage, reading as a separate item. `gw add` now refuses such titles, and
// rendering collapses control whitespace so data written before that guard
// still renders one row per item.
test('a stored newline title renders as one row, not two', () => {
  const { root, store } = board();
  store.writeItems([...items, { id: 'P9-01', title: 'a\nb', phase: null, stage: 'backlog', flag: null }]);
  const out = execFileSync(process.execPath, [BIN, 'list'], { cwd: root, encoding: 'utf8' });
  const rows = out.split('\n').filter((line) => line.startsWith('P'));
  assert.deepEqual(rows, [
    'P1-01  backlog  First',
    'P2-02  building  Second',
    'P9-01  backlog  a b',
  ]);
});
