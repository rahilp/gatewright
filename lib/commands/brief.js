import { execFileSync } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { blockedDep, computeBuckets, renderBrief } from '../brief.js';
import { inFlightTitles } from '../brief.js';
import { createMemory } from '../memory/provider.js';

export const spec = { summary: 'what is in flight, blocked, owned, and next', flags: { me: { type: 'string' }, json: { type: 'boolean' }, recall: { type: 'boolean' } } };

// Local and normally instant; see lib/git.js for why this is bounded anyway.
const GIT_STATE_TIMEOUT_MS = 10_000;

function gitState(root) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_STATE_TIMEOUT_MS }).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_STATE_TIMEOUT_MS }).trim();
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
    // The buckets the text view computes, as data. The computation is imported
    // from lib/brief.js -- the same functions renderBrief uses -- so the JSON
    // and the human text can never disagree about what "in flight" or
    // "blocked" means. Existing keys (items, events, stages, config, git,
    // output) are kept untouched; this only adds.
    const { dispatched, inFlight, blocked, triage, next } = computeBuckets(state, ctx.flags);
    const buckets = {
      dispatched: dispatched.map((item) => item.id),
      in_flight: inFlight.map((item) => item.id),
      blocked: blocked.map((item) => ({ id: item.id, waiting_on: blockedDep(item, state.items, state.stages) })),
      needs_triage: triage.map((item) => item.id),
      next_unblocked: next.map((item) => item.id),
    };
    ctx.stdout.write(`${JSON.stringify({ ...state, output, brief: buckets })}\n`);
  } else ctx.stdout.write(output);
}
