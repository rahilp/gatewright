import { basename } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createGit } from '../git.js';
import { readConfig } from '../config.js';
import { IOError } from '../cli/errors.js';
import { resolveRoles, isTerminalStage } from '../stages.js';
import { eventsKeep, openItemIds, partitionEvents } from '../store.js';
import { normalizePath } from '../util/paths.js';

export const spec = {
  summary: 'remove terminal-stage worktrees, or compact the event log',
  flags: { 'dry-run': { type: 'boolean' }, force: { type: 'boolean' }, events: { type: 'boolean' } },
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

// T-0135 — events.jsonl only ever grows: at the audited dogfood pace a board
// inlines megabytes into every `gw open`, nearly all of it the history of
// items that finished months ago. Compaction MOVES that history to
// events-archive.jsonl rather than deleting it: the audit trail is the point
// of an append-only log, and a greppable sibling file is still an audit trail.
//
// The archive is appended BEFORE events.jsonl is rewritten. A crash between
// the two leaves events already in both files, which is a duplicate a human
// can see; the other order loses them.
function compactEvents(ctx, { stages }) {
  const { store, flags, stdout } = ctx;
  const keep = eventsKeep(readConfig(store));
  const archiveName = basename(store.paths.eventsArchive);

  const plan = () => {
    const open = openItemIds(store.readItems(), stages);
    return partitionEvents(store.readEvents(), { open, keep });
  };

  if (flags['dry-run']) {
    const { kept, archived } = plan();
    if (!archived.length) {
      stdout.write(`events.jsonl is already compact (${kept.length} events, keeping ${keep} per finished item)\n`);
      return 0;
    }
    stdout.write(`would archive ${archived.length} events to .gatewright/${archiveName}, keeping ${kept.length}\n`);
    return 0;
  }

  // Under the lock: the partition is computed from the same events.jsonl the
  // rewrite replaces, so a concurrent `gw move` cannot have its event read
  // before the split and appended after it, where the rewrite would drop it.
  return store.withLock(() => {
    const { kept, archived } = plan();
    if (!archived.length) {
      stdout.write(`events.jsonl is already compact (${kept.length} events, keeping ${keep} per finished item)\n`);
      return 0;
    }
    store.archiveEvents(archived);
    store.replaceEvents(kept);
    store.appendEvent({ type: 'compact', by: ctx.actor, kept: kept.length, archived: archived.length, keep, archive: archiveName });
    stdout.write(`archived ${archived.length} events to .gatewright/${archiveName}, keeping ${kept.length}\n`);
    return 0;
  });
}

export function run(ctx, { git = createGit() } = {}) {
  const stages = JSON.parse(readFileSync(ctx.store.paths.stages, 'utf8'));
  // The event log is the board's own file: compacting it needs no git, and
  // refusing it outside a checkout would deny compaction to exactly the
  // boards that are not in one.
  if (ctx.flags.events) return compactEvents(ctx, { stages });
  const roles = resolveRoles(stages);
  const items = new Map(ctx.store.readItems().map((item) => [item.id, item]));
  // T-0011 — a board can live outside a git repository (worktrees are a git
  // feature, the board is not). Dumping git's raw stderr taught nothing; say
  // the problem and the fix in the tool's own voice, and keep exit 3, which
  // already meant "the environment, not the command, is wrong".
  let listed;
  try {
    listed = parseWorktrees(git.run(['worktree', 'list', '--porcelain'], { cwd: ctx.root }).stdout);
  } catch (error) {
    if (!/not a git repository/i.test(String(error.message))) throw error;
    throw new IOError(`gw gc needs a git repository: ${ctx.root} is not inside one. Run \`git init\` in this directory, or run gw gc from a git checkout.`);
  }
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
