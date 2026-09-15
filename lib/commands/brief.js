import { execFileSync } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { renderBrief } from '../brief.js';
import { inFlightTitles } from '../brief.js';
import { createMemory } from '../memory/provider.js';

export const spec = { flags: { me: { type: 'string' }, json: { type: 'boolean' }, recall: { type: 'boolean' } } };

function gitState(root) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return branch && sha ? { branch, sha } : null;
  } catch { return null; }
}

export async function run(ctx) {
  const state = { items: ctx.store.readItems(), events: ctx.store.readEvents(), stages: readStages(ctx.store), config: readConfig(ctx.store), git: gitState(ctx.root) };
  let relatedMemory = [];
  // Plain brief is intentionally a pure local read. The provider is not even
  // constructed unless the explicit recall flag is present.
  if (ctx.flags.recall && state.config.memory?.enabled) {
    const memory = ctx.memory ?? createMemory({ config: state.config, transport: ctx.memoryTransport, log: { root: ctx.root } });
    relatedMemory = await memory.recall(inFlightTitles(state).join(' '), 3);
  }
  const output = renderBrief(state, { ...ctx.flags, relatedMemory });
  if (ctx.flags.json) {
    ctx.stdout.write(JSON.stringify({ ...state, output }) + '\n');
  } else ctx.stdout.write(output);
}
