import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { run as gc } from '../lib/commands/gc.js';
import { IOError } from '../lib/cli/errors.js';
import { normalizePath } from '../lib/util/paths.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gw-gc-'));
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']);
  writeFileSync(join(root, 'README'), 'base\n'); git(['add', 'README']); git(['commit', '-m', 'base']);
  const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'queue', role: 'initial' }, { id: 'shipped', role: 'done' }, { id: 'discarded', role: 'dropped' }], terminal: [], extra: [] }));
  writeFileSync(store.paths.config, '{}');
  return { root, store, git };
}

function addItem(board, id, stage) {
  const items = board.store.readItems(); items.push({ id, title: id, stage }); board.store.writeItems(items);
  const path = join(board.root, '.gatewright', '.worktrees', id);
  board.git(['worktree', 'add', path, '-b', `gw/${id}`]);
  return path;
}

function ctx(board, flags = {}) {
  return { root: board.root, store: board.store, flags, actor: 'human:test', stdout: { text: '', write(s) { this.text += s; } }, stderr: { text: '', write(s) { this.text += s; } } };
}

test('gc dry-run removes nothing and only selects role-terminal worktrees', () => {
  const board = repo(); const done = addItem(board, 'P4-01', 'shipped'); const live = addItem(board, 'P4-02', 'queue');
  const context = ctx(board, { 'dry-run': true }); gc(context);
  assert.match(context.stdout.text, /would remove/); assert.doesNotMatch(context.stdout.text, /P4-02/);
  assert.equal(existsSync(done), true); assert.equal(existsSync(live), true);
});

test('gc refuses dirty worktrees with file list, then force removes them', () => {
  const board = repo(); const path = addItem(board, 'P4-03', 'shipped');
  writeFileSync(join(path, 'unfinished.txt'), 'half done\n');
  const refused = ctx(board); gc(refused);
  assert.match(refused.stderr.text, /unfinished\.txt/); assert.equal(existsSync(path), true);
  const forced = ctx(board, { force: true }); gc(forced);
  assert.equal(existsSync(path), false);
  // board.root is an OS path (backslashes on Windows, and on Windows CI a
  // short 8.3 form like `RUNNER~1` with whatever drive-letter case the OS
  // handed us); git always reports forward slashes in long form with
  // corrected case. Comparing either raw against the other fails for
  // reasons that have nothing to do with gc's correctness, so both sides go
  // through the same canonicalisation gc itself relies on.
  const slash = (s) => s.replace(/\\/g, '/');
  const canonicalRoot = slash(normalizePath(board.root));
  assert.equal(slash(board.git(['worktree', 'list', '--porcelain'])).includes(canonicalRoot), true);
});

test('gc honors declared terminal stages in a custom pipeline', () => {
  const board = repo();
  writeFileSync(board.store.paths.stages, JSON.stringify({ stages: [{ id: 'todo', role: 'initial' }, { id: 'complete', role: 'done' }, { id: 'archive', role: 'dropped' }], terminal: [], extra: [] }));
  const path = addItem(board, 'P4-04', 'complete'); gc(ctx(board));
  assert.equal(existsSync(path), false);
  assert.doesNotMatch(readFileSync(board.store.paths.stages, 'utf8'), /verified|merged/);
});

// A board directory without git around it: store.ensure() creates the board
// files, and stages.json is written the way repo() does, so the failure gc
// hits is genuinely git's, not a half-built board.
function nogitBoard(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'queue', role: 'initial' }, { id: 'shipped', role: 'done' }], terminal: [], extra: [] }));
  writeFileSync(store.paths.config, '{}');
  return { root, store };
}

// T-0011 — a board can live outside a git repository. git's raw stderr
// ("fatal: not a git repository (or any parent up to mount point /)...") is
// replaced with the problem and the fix in gw's own voice, at the same
// exit 3 that already means "the environment, not the command".
test('gc outside a git repository fails at exit 3 with the problem and the fix, not git stderr', () => {
  const { root, store } = nogitBoard('gw-gc-nogit-');
  let thrown = null;
  try { gc(ctx({ root, store }, { 'dry-run': true })); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof IOError, 'not a git repository is an environment failure (exit 3), not a usage error');
  assert.equal(thrown.exitCode, 3);
  assert.equal(
    thrown.message,
    `gw gc needs a git repository: ${root} is not inside one. Run \`git init\` in this directory, or run gw gc from a git checkout.`,
  );
  assert.doesNotMatch(thrown.message, /fatal/);
});

test('gc exits 3 through the real binary outside a git repository', () => {
  const { root } = nogitBoard('gw-gc-nogit-bin-');
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'gc', '--dry-run'], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 3 && /gw gc needs a git repository/.test(error.stderr) && !/fatal/.test(error.stderr),
  );
});

test('a git failure that is not "not a git repository" still surfaces untouched', () => {
  const board = repo();
  const failing = { run: () => { throw new Error('git worktree list --porcelain failed: index locked'); } };
  assert.throws(() => gc(ctx(board, { 'dry-run': true }), { git: failing }), /index locked/);
});

// T-0135 — events.jsonl is append-only and never shrinks. At the audited
// dogfood pace (~235 events/day) a board that lives a year inlines megabytes
// into every `gw open`, nearly all of it the history of items that are done.
// `gw gc --events` MOVES that history to events-archive.jsonl; it never
// deletes it, because the audit trail is the point of the log.
function eventsBoard(prefix = 'gw-gc-events-') {
  const { root, store } = nogitBoard(prefix);
  store.writeItems([{ id: 'T-1', title: 'open work', stage: 'queue' }, { id: 'T-2', title: 'finished', stage: 'shipped' }]);
  return { root, store };
}

function fillEvents(store, item, count, type = 'note') {
  for (let i = 0; i < count; i += 1) store.appendEvent({ type, item, by: 'human:test', n: i });
}

test('gc --events keeps every open-item event, tails terminal ones, and archives the rest', () => {
  const board = eventsBoard();
  fillEvents(board.store, 'T-1', 30);
  fillEvents(board.store, 'T-2', 30);
  const context = ctx(board, { events: true });
  gc(context);

  const kept = board.store.readEvents();
  assert.equal(kept.filter((e) => e.item === 'T-1').length, 30, 'an open item keeps all of its history');
  assert.equal(kept.filter((e) => e.item === 'T-2').length, 20, 'a terminal item keeps the configured tail');
  assert.deepEqual(kept.filter((e) => e.item === 'T-2').map((e) => e.n), Array.from({ length: 20 }, (_, i) => i + 10));

  const archived = readFileSync(board.store.paths.eventsArchive, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(archived.length, 10);
  assert.deepEqual(archived.map((e) => e.n), Array.from({ length: 10 }, (_, i) => i));
  assert.match(context.stdout.text, /archived 10 events/);
  assert.match(context.stdout.text, /events-archive\.jsonl/);
});

test('gc --events records a compact event stating what moved', () => {
  const board = eventsBoard();
  fillEvents(board.store, 'T-2', 25);
  gc(ctx(board, { events: true }));
  const compact = board.store.readEvents().at(-1);
  assert.equal(compact.type, 'compact');
  assert.equal(compact.archived, 5);
  assert.equal(compact.kept, 20);
  assert.equal(compact.by, 'human:test');
  assert.equal(compact.archive, 'events-archive.jsonl');
  assert.ok(compact.ts, 'the compact event is stamped like every other event');
});

test('gc --events --dry-run reports the counts and writes nothing', () => {
  const board = eventsBoard();
  fillEvents(board.store, 'T-2', 25);
  const before = readFileSync(board.store.paths.events, 'utf8');
  const context = ctx(board, { events: true, 'dry-run': true });
  gc(context);
  assert.match(context.stdout.text, /would archive 5 events/);
  assert.equal(readFileSync(board.store.paths.events, 'utf8'), before);
  assert.equal(existsSync(board.store.paths.eventsArchive), false);
});

test('gc --events appends to an existing archive instead of replacing it', () => {
  const board = eventsBoard();
  fillEvents(board.store, 'T-2', 25);
  gc(ctx(board, { events: true }));
  fillEvents(board.store, 'T-2', 25);
  gc(ctx(board, { events: true }));
  const archived = readFileSync(board.store.paths.eventsArchive, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(archived.length, 30, 'the first run\'s archived events are still there');
  assert.deepEqual(archived.slice(0, 5).map((e) => e.n), [0, 1, 2, 3, 4], 'the first run\'s lines are still at the top of the archive, in order');
  assert.equal(board.store.readEvents().filter((e) => e.type === 'compact').length, 2, 'both runs are recorded in the hot log');
});

test('gc --events says so and writes nothing when the log is already compact', () => {
  const board = eventsBoard();
  fillEvents(board.store, 'T-2', 3);
  const context = ctx(board, { events: true });
  gc(context);
  assert.match(context.stdout.text, /already compact/);
  assert.equal(existsSync(board.store.paths.eventsArchive), false);
  assert.equal(board.store.readEvents().length, 3, 'no compact event is recorded when nothing moved');
});

test('gc --events honors config.gc.events_keep', () => {
  const board = eventsBoard();
  writeFileSync(board.store.paths.config, JSON.stringify({ gc: { events_keep: 2 } }));
  fillEvents(board.store, 'T-2', 10);
  gc(ctx(board, { events: true }));
  assert.equal(board.store.readEvents().filter((e) => e.item === 'T-2').length, 2);
});

// The worktree half of gc needs git; the events half is pure file work on the
// board itself, and refusing it outside a checkout would deny compaction to
// exactly the boards that are not in a repository.
test('gc --events works outside a git repository and leaves worktrees alone', () => {
  const board = eventsBoard('gw-gc-events-nogit-');
  fillEvents(board.store, 'T-2', 25);
  const context = ctx(board, { events: true });
  gc(context, { git: { run: () => { throw new Error('git must not be called'); } } });
  assert.match(context.stdout.text, /archived 5 events/);
  assert.doesNotMatch(context.stdout.text, /would remove/);
});

test('gc --events runs under the store lock through the real binary', () => {
  const board = eventsBoard('gw-gc-events-bin-');
  fillEvents(board.store, 'T-2', 25);
  const out = execFileSync(process.execPath, [BIN, 'gc', '--events'], { cwd: board.root, encoding: 'utf8', env: { ...process.env, GW_ROOT: '', GW_ACTOR: 'human:test' } });
  assert.match(out, /archived 5 events/);
  assert.equal(existsSync(join(board.root, '.gatewright', '.lock')), false, 'the lock is released');
});
