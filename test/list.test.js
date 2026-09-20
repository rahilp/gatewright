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

// T-0138 — `gw list` on a 2,000-item board printed 2,001 lines into whatever
// was reading it, and the only way to see fewer was to already know a stage
// or phase to filter by.
const manyItems = [
  { id: 'P1-01', title: 'Fix the login redirect', phase: 'P1', stage: 'backlog', flag: null, owner: 'human:rahil' },
  { id: 'P1-02', title: 'Rename the LOGIN button', phase: 'P1', stage: 'building', flag: null, owner: 'agent:codex' },
  { id: 'P2-03', title: 'Write the release notes', phase: 'P2', stage: 'backlog', flag: null, owner: null },
  { id: 'P2-04', title: 'Unowned and unrelated', phase: 'P2', stage: 'backlog', flag: null },
];
function loaded(items = manyItems) {
  const root = mkdtempSync(join(tmpdir(), 'gw-list-')); const store = createStore(root); store.ensure(); store.writeItems(items);
  return { root, store };
}
const rowsOf = (output) => output.split('\n').filter(Boolean);
const gw = (root, argv) => execFileSync(process.execPath, [BIN, ...argv], { cwd: root, encoding: 'utf8' });

test('--limit caps the rows and says how many it held back', () => {
  const { root } = loaded();
  const rows = rowsOf(gw(root, ['list', '--limit', '2']));
  assert.deepEqual(rows.slice(0, 2).map((row) => row.split('  ')[0]), ['P1-01', 'P1-02']);
  assert.equal(rows[2], '(+2 more of 4 matched — raise --limit, or narrow the filter)');
  assert.equal(rows.length, 3);
});

test('--limit applies to --json too, and keeps the array shape scripts already parse', () => {
  const { root } = loaded();
  const limited = JSON.parse(gw(root, ['list', '--json', '--limit', '1']));
  assert.ok(Array.isArray(limited));
  assert.deepEqual(limited.map((item) => item.id), ['P1-01']);
});

test('a limit that is not a count is refused, not rounded', () => {
  const { root } = loaded();
  for (const value of ['0', '-3', 'lots', '2.5']) {
    assert.throws(
      () => gw(root, ['list', '--limit', value]),
      (error) => error.status === 2 && /--limit needs a whole number of items, at least 1/.test(error.stderr),
      `--limit ${value}`,
    );
  }
});

test('--owner matches the qualified and bare spellings of the same person, and none finds the unowned', () => {
  const { root } = loaded();
  assert.deepEqual(rowsOf(gw(root, ['list', '--owner', 'rahil'])).map((row) => row.split('  ')[0]), ['P1-01']);
  assert.deepEqual(rowsOf(gw(root, ['list', '--owner', 'human:rahil'])).map((row) => row.split('  ')[0]), ['P1-01']);
  assert.deepEqual(rowsOf(gw(root, ['list', '--owner', 'agent:codex'])).map((row) => row.split('  ')[0]), ['P1-02']);
  // A qualifier that disagrees is a different actor, exactly as sameOwner says.
  assert.deepEqual(rowsOf(gw(root, ['list', '--owner', 'human:codex'])), []);
  assert.deepEqual(rowsOf(gw(root, ['list', '--owner', 'none'])).map((row) => row.split('  ')[0]), ['P2-03', 'P2-04']);
});

test('free text matches a title or an id, case-insensitively, and composes with the flags', () => {
  const { root } = loaded();
  assert.deepEqual(rowsOf(gw(root, ['list', 'login'])).map((row) => row.split('  ')[0]), ['P1-01', 'P1-02']);
  assert.deepEqual(rowsOf(gw(root, ['list', 'P2-'])).map((row) => row.split('  ')[0]), ['P2-03', 'P2-04']);
  assert.deepEqual(rowsOf(gw(root, ['list', '--stage', 'backlog', 'login'])).map((row) => row.split('  ')[0]), ['P1-01']);
  assert.deepEqual(rowsOf(gw(root, ['list', 'nothing matches this'])), []);
});

test('without a flag or a search, list prints what it always printed', () => {
  const { root } = loaded();
  assert.deepEqual(rowsOf(gw(root, ['list'])), [
    'P1-01  backlog  Fix the login redirect',
    'P1-02  building  Rename the LOGIN button',
    'P2-03  backlog  Write the release notes',
    'P2-04  backlog  Unowned and unrelated',
  ]);
  assert.deepEqual(JSON.parse(gw(root, ['list', '--json'])), manyItems);
});

// The budget this exists for: a big board must be readable in a fixed number
// of lines, without knowing anything about what is on it.
test('a two-thousand-item board answers in as many lines as it was asked for', () => {
  const bulk = Array.from({ length: 2000 }, (unused, index) => ({ id: `P1-${index}`, title: `Item ${index}`, phase: 'P1', stage: 'backlog', flag: null }));
  const { root } = loaded(bulk);
  assert.equal(rowsOf(gw(root, ['list'])).length, 2000);
  const capped = rowsOf(gw(root, ['list', '--limit', '25']));
  assert.equal(capped.length, 26);
  assert.equal(capped[25], '(+1975 more of 2000 matched — raise --limit, or narrow the filter)');
});
