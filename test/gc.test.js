import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run as gc } from '../lib/commands/gc.js';

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
  return { root: board.root, store: board.store, flags, stdout: { text: '', write(s) { this.text += s; } }, stderr: { text: '', write(s) { this.text += s; } } };
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
  assert.match(board.git(['worktree', 'list', '--porcelain']), new RegExp(board.root));
});

test('gc honors declared terminal stages in a custom pipeline', () => {
  const board = repo();
  writeFileSync(board.store.paths.stages, JSON.stringify({ stages: [{ id: 'todo', role: 'initial' }, { id: 'complete', role: 'done' }, { id: 'archive', role: 'dropped' }], terminal: [], extra: [] }));
  const path = addItem(board, 'P4-04', 'complete'); gc(ctx(board));
  assert.equal(existsSync(path), false);
  assert.doesNotMatch(readFileSync(board.store.paths.stages, 'utf8'), /verified|merged/);
});
