import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { IOError } from './errors.js';

export function findRoot(cwd, env) {
  if (env.GW_ROOT) return dirname(resolve(env.GW_ROOT));
  let here = resolve(cwd);
  for (;;) {
    if (existsSync(join(here, '.gatewright'))) return here;
    const parent = dirname(here);
    if (parent === here) break;
    here = parent;
  }
  throw new IOError('no .gatewright/ found here or in any parent directory. Run `gw init` to create one.');
}

export function actor(flags, env) {
  return flags.by || env.GW_ACTOR || `human:${env.USER || env.USERNAME || 'unknown'}`;
}
