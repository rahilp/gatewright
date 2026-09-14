import { execFileSync } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { renderBrief } from '../brief.js';

export const spec = { flags: { me: { type: 'string' }, json: { type: 'boolean' }, recall: { type: 'boolean' } } };

function gitState(root) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return branch && sha ? { branch, sha } : null;
  } catch { return null; }
}

export function run(ctx) {
  const state = { items: ctx.store.readItems(), events: ctx.store.readEvents(), stages: readStages(ctx.store), config: readConfig(ctx.store), git: gitState(ctx.root) };
  if (ctx.flags.json) {
    ctx.stdout.write(JSON.stringify({ ...state, output: renderBrief(state, ctx.flags) }) + '\n');
  } else ctx.stdout.write(renderBrief(state, ctx.flags));
}
