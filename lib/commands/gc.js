import { existsSync, readFileSync } from 'node:fs';
import { createGit } from '../git.js';
import { resolveRoles, isTerminalStage } from '../stages.js';
import { normalizePath } from '../util/paths.js';

export const spec = {
  summary: 'remove terminal-stage worktrees',
  flags: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' } },
  positionals: [],
};

function parseWorktrees(output) {
  const result = [];
  let current;
  for (const line of String(output ?? '').split('\n')) {
    if (!line) { if (current) result.push(current); current = null; continue; }
    const [key, ...rest] = line.split(' ');
    if (key === 'worktree') current = { path: rest.join(' ') };
    else if (current && key === 'branch') current.branch = rest.join(' ');
  }
  if (current) result.push(current);
  return result;
}

// git reports worktree paths with forward slashes, even on Windows, so this
// splits on either separator rather than assuming the OS-native one.
function itemId(path) { return path.split(/[\\/]/).at(-1); }

function dirtyFiles(git, path) {
  const output = git.run(['status', '--short'], { cwd: path }).stdout;
  return String(output).split('\n').filter(Boolean).map((line) => line.slice(3).trim());
}

export function run(ctx, { git = createGit() } = {}) {
  const stages = JSON.parse(readFileSync(ctx.store.paths.stages, 'utf8'));
  const roles = resolveRoles(stages);
  const items = new Map(ctx.store.readItems().map((item) => [item.id, item]));
  const listed = parseWorktrees(git.run(['worktree', 'list', '--porcelain'], { cwd: ctx.root }).stdout);
  const candidates = listed.filter((entry) => {
    const item = items.get(itemId(entry.path));
    return item && (isTerminalStage(item.stage, stages, roles) || item.stage === roles.done);
  });

  for (const entry of candidates) {
    const id = itemId(entry.path);
    const path = normalizePath(entry.path);
    const dirty = existsSync(path) ? dirtyFiles(git, path) : [];
    if (dirty.length && !ctx.flags.force) {
      ctx.stderr.write(`gw gc: refusing ${id}; worktree has uncommitted changes:\n`);
      for (const file of dirty) ctx.stderr.write(`  ${file}\n`);
      continue;
    }
    if (ctx.flags['dry-run']) {
      ctx.stdout.write(`would remove ${entry.path} (${id})\n`);
      continue;
    }
    const argv = ['worktree', 'remove'];
    if (ctx.flags.force) argv.push('--force');
    argv.push(entry.path);
    git.run(argv, { cwd: ctx.root });
    ctx.stdout.write(`removed ${entry.path} (${id})\n`);
  }
}
