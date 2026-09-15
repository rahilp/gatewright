import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGit } from '../git.js';
import { normalizePath } from '../util/paths.js';

function listedWorktrees(output) {
  const entries = [];
  let entry = null;
  for (const line of String(output ?? '').split('\n')) {
    if (!line) { if (entry) entries.push(entry); entry = null; continue; }
    const [key, ...rest] = line.split(' ');
    if (key === 'worktree') entry = { path: rest.join(' ') };
    else if (entry && key === 'branch') entry.branch = rest.join(' ');
  }
  if (entry) entries.push(entry);
  return entries;
}

// One item gets one stable path and one stable branch.  The command boundary
// is injected so unit tests can inspect argv without creating a worktree.

export function createWorktree({ git = createGit() } = {}) {
  function ensure({ root, item, config = {} }) {
    if (!root) throw new TypeError('worktree ensure requires the main repository root.');
    if (!item?.id) throw new TypeError('worktree ensure requires an item id.');
    const worktreeRoot = resolve(root, config.runner?.worktree_root ?? '.gatewright/.worktrees');
    const path = join(worktreeRoot, item.id);
    const branch = `refs/heads/gw/${item.id}`;
    const listed = listedWorktrees(git.run(['worktree', 'list', '--porcelain'], { cwd: root }).stdout);
    // git reports worktree paths with forward slashes (even on Windows) and
    // with symlinks resolved. On macOS a repository under /var or /tmp is
    // really /private/var or /private/tmp, so comparing an unresolved path
    // against git's output never matches and we would conclude a registered
    // worktree is a stray directory.
    const existing = listed.find((entry) => normalizePath(entry.path) === normalizePath(path));

    if (existing) {
      if (existing.branch !== branch) throw new Error(`worktree ${path} belongs to ${existing.branch ?? 'a detached HEAD'}, not gw/${item.id}.`);
      return { path, reused: true, branch: `gw/${item.id}` };
    }
    if (existsSync(path)) throw new Error(`worktree path exists but is not a registered worktree: ${path}`);

    try {
      git.run(['show-ref', '--verify', '--quiet', branch], { cwd: root });
      throw new Error(`branch gw/${item.id} already exists without its worktree at ${path}.`);
    } catch (error) {
      if (error.message.includes(`branch gw/${item.id} already exists`)) throw error;
      // show-ref exits non-zero for an absent branch; that is the only failure
      // we may recover from here.
      if (!error.message.includes('show-ref --verify --quiet')) throw error;
    }

    mkdirSync(worktreeRoot, { recursive: true });
    git.run(['worktree', 'add', path, '-b', `gw/${item.id}`], { cwd: root });
    return { path, reused: false, branch: `gw/${item.id}` };
  }
  return { ensure };
}
