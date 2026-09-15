import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IOError } from './errors.js';
import { normalizePath } from '../util/paths.js';

function enclosingGitRoot(cwd) {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

// `git rev-parse --show-toplevel` reports forward slashes even on Windows,
// while `path.join`/`resolve` report OS-native separators, so both sides go
// through the shared normaliser before comparing.
function isWithin(path, parent) {
  const fromParent = relative(normalizePath(parent), normalizePath(path));
  return fromParent === '' || (!fromParent.startsWith(`..${sep}`) && fromParent !== '..' && !isAbsolute(fromParent));
}

export function findRoot(cwd, env, options = {}) {
  const { stopAt, stderr = process.stderr, getGitRoot = enclosingGitRoot } = typeof options === 'string' ? { stopAt: options } : options;
  const gitRoot = getGitRoot(cwd);
  const warnIfOutsideGit = (root) => {
    if (gitRoot && !isWithin(root, gitRoot)) stderr.write(`gw: warning: using .gatewright root outside this git repository: ${root}\n`);
    return root;
  };
  if (env.GW_ROOT) return warnIfOutsideGit(dirname(resolve(env.GW_ROOT)));
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

export function actor(flags, env) {
  return flags.by || env.GW_ACTOR || `human:${env.USER || env.USERNAME || 'unknown'}`;
}
