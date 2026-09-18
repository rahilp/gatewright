import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { IOError, UsageError } from './errors.js';
import { isWithin } from '../util/paths.js';

// This runs ahead of every command, so an unbounded hang here would freeze
// the whole CLI, not just one subcommand. `rev-parse --show-toplevel` is
// local and normally instant; see lib/git.js for the same reasoning.
const GIT_ROOT_LOOKUP_TIMEOUT_MS = 10_000;

function enclosingGitRoot(cwd) {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_ROOT_LOOKUP_TIMEOUT_MS }).trim());
  } catch {
    return null;
  }
}

export function findRoot(cwd, env, options = {}) {
  const { stopAt, stderr = process.stderr, getGitRoot = enclosingGitRoot } = typeof options === 'string' ? { stopAt: options } : options;
  const gitRoot = getGitRoot(cwd);
  const warnIfOutsideGit = (root) => {
    if (gitRoot && !isWithin(root, gitRoot)) stderr.write(`gw: warning: using .gatewright root outside this git repository: ${root}\n`);
    return root;
  };
  if (env.GW_ROOT) {
    // T-0026 — GW_ROOT names the project root: the directory that contains
    // .gatewright/. That is what the name says and what every reader assumes;
    // the old reading — the .gatewright directory itself — pointed the board
    // at its parent, so a value aimed at a project root silently read, and on
    // the next write silently created, a board one level too high. A path
    // ending in .gatewright is still accepted as the old form, with a
    // deprecation warning, so anyone who relied on the old meaning is told
    // rather than silently relocated. And because a root chosen here is never
    // re-checked, a value naming a place with no board is refused instead of
    // quietly reading an empty board — or, on the next write, creating one:
    // only `gw init` creates boards, and it says so.
    const given = resolve(env.GW_ROOT);
    const legacy = basename(given) === '.gatewright';
    const root = legacy ? dirname(given) : given;
    if (!existsSync(join(root, '.gatewright'))) {
      throw new IOError(`no .gatewright/ found at GW_ROOT (${root}). GW_ROOT names the project root that contains .gatewright/, not the board directory itself, and gw will not create a board there as a side effect: run \`gw init\` in ${root} first, or unset GW_ROOT.`);
    }
    if (legacy) stderr.write(`gw: warning: GW_ROOT now names the project root — the directory containing .gatewright/ — not .gatewright/ itself; using ${root}. Pass the project root to silence this warning.\n`);
    return warnIfOutsideGit(root);
  }
  let here = resolve(cwd);
  const boundary = stopAt ? resolve(stopAt) : null;
  for (;;) {
    if (existsSync(join(here, '.gatewright'))) return warnIfOutsideGit(here);
    if (here === boundary) break;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  throw new IOError('no .gatewright/ found here or in any parent directory. Run `gw init` to create one.');
}

// T-0030 — the actor is who the audit trail blames, so `--by agent` and
// GW_ACTOR=agent must not slide through: a bare kind with no name is refused
// here, at the one place every command's actor passes through, with the
// convention named.
//
// T-0052 — a bare name is the most natural thing a person types (`--by
// rahil`), and it used to be discarded: `add` recorded "human", losing the
// name entirely. Every actor is now qualified — `agent:<name>` as before, a
// bare name as `human:<name>` — because the qualified form is what the rest
// of the system compares against, and `sameOwner` already treated a bare
// name as matching its qualified form, so nothing that compared owners
// changes. Only a bare kind (`agent`, `human`) stays refused: it names no
// one, and silently meaning "the default user" would be the same bug in
// another costume.
export function actor(flags, env) {
  const who = flags.by || env.GW_ACTOR;
  const name = String(who ?? '').trim();
  if (/^agent:?$/u.test(name)) {
    throw new UsageError(`the actor names no agent: use --by agent:<name>, for example --by agent:codex (or export GW_ACTOR=agent:<name>)`);
  }
  if (!name || /^human:?$/u.test(name)) return `human:${env.USER || env.USERNAME || 'unknown'}`;
  return /^(?:agent|human):/.test(name) ? name : `human:${name}`;
}
