import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../lib/git.js';
import { createWorktree } from '../lib/run/worktree.js';

test('worktree creation uses the injected git argv boundary', () => {
  const calls = []; const root = mkdtempSync(join(tmpdir(), 'gw-worktree-stub-'));
  const git = { run(argv) { calls.push(argv); if (argv[0] === 'worktree' && argv[1] === 'list') return { stdout: `worktree ${root}\nbranch refs/heads/main\n\n` }; if (argv[0] === 'show-ref') throw new Error(`git ${argv.join(' ')} failed: absent`); return { stdout: '', status: 0 }; } };
  const result = createWorktree({ git }).ensure({ root, item: { id: 'P4-05' }, config: {} });
  assert.equal(result.reused, false);
  assert.deepEqual(calls.at(-1), ['worktree', 'add', join(root, '.gatewright', '.worktrees', 'P4-05'), '-b', 'gw/P4-05']);
});

test('worktree reuse returns the registered item path without git add', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-worktree-reuse-')); const path = join(root, '.gatewright', '.worktrees', 'P4-05'); let adds = 0;
  const git = { run(argv) { if (argv[1] === 'list') return { stdout: `worktree ${root}\nbranch refs/heads/main\n\nworktree ${path}\nbranch refs/heads/gw/P4-05\n\n` }; if (argv[1] === 'add') adds += 1; return { stdout: '', status: 0 }; } };
  const result = createWorktree({ git }).ensure({ root, item: { id: 'P4-05' }, config: {} });
  assert.equal(result.reused, true); assert.equal(adds, 0);
});

test('stray worktree directory and orphan branch fail clearly', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-worktree-errors-')); const path = join(root, '.gatewright', '.worktrees', 'P4-05');
  mkdirSync(join(root, '.gatewright', '.worktrees'), { recursive: true });
  writeFileSync(path, 'stray', { flag: 'w' });
  const git = { run(argv) { if (argv[1] === 'list') return { stdout: `worktree ${root}\nbranch refs/heads/main\n\n` }; return { stdout: '', status: 0 }; } };
  assert.throws(() => createWorktree({ git }).ensure({ root, item: { id: 'P4-05' }, config: {} }), /not a registered worktree/);
  const empty = mkdtempSync(join(tmpdir(), 'gw-worktree-branch-'));
  const branchGit = { run(argv) { if (argv[1] === 'list') return { stdout: `worktree ${empty}\nbranch refs/heads/main\n\n` }; if (argv[0] === 'show-ref') return { stdout: '', status: 0 }; throw new Error('unexpected'); } };
  assert.throws(() => createWorktree({ git: branchGit }).ensure({ root: empty, item: { id: 'P4-05' }, config: {} }), /branch gw\/P4-05 already exists/);
});

test('real git worktree reuse is confined to a temporary repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-worktree-real-'));
  const git = (argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8' });
  git(['init']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test']); writeFileSync(join(root, 'README'), 'base\n'); git(['add', 'README']); git(['commit', '-m', 'base']);
  const worktree = createWorktree({ git: createGit() }); const first = worktree.ensure({ root, item: { id: 'P4-05' }, config: {} }); const second = worktree.ensure({ root, item: { id: 'P4-05' }, config: {} });
  assert.equal(first.reused, false); assert.equal(second.reused, true); assert.equal(existsSync(first.path), true);
});
