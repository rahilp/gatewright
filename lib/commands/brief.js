import { execFileSync } from 'node:child_process';
import { readConfig, readStages } from '../config.js';
import { briefJson, renderBrief } from '../brief.js';
import { inFlightTitles } from '../brief.js';
import { createMemory } from '../memory/provider.js';

export const spec = { summary: 'what is in flight, blocked, owned, and next', flags: { me: { type: 'string', optionalValue: true }, json: { type: 'boolean' }, recall: { type: 'boolean' } } };

// T-0069 — `--me` used to only filter the DISPATCHED and IN FLIGHT buckets,
// so on a board where everything owned by others sat in the other buckets
// the output was byte-identical to the unfiltered brief: a silent no-op.
// Now every section filters to the given owner, and a bare `--me` (or
// `--me=`) means "the actor I resolved as" — the same actor every write
// would be recorded under.
function resolveMe(flags, actor) {
  const raw = flags.me;
  if (raw === undefined) return undefined;
  return raw === true || raw === '' ? actor : String(raw);
}

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
  const me = resolveMe(ctx.flags, ctx.actor);
  const state = {
    items: ctx.store.readItems(), events: ctx.store.readEvents(), stages: readStages(ctx.store),
    config: readConfig(ctx.store), git: gitState(ctx.root), digest: ctx.store.verifyDigest(),
  };
  let relatedMemory = [];
  // Plain brief is intentionally a pure local read. The provider is not even
  // constructed unless the explicit recall flag is present.
  if (ctx.flags.recall && state.config.memory?.enabled) {
    const memory = ctx.memory ?? createMemory({ config: state.config, transport: ctx.memoryTransport, log: { root: ctx.root } });
    relatedMemory = await memory.recall(inFlightTitles(state).join(' '), 3);
  }
  if (ctx.flags.json) {
    // T-0032 — --json ships the brief and nothing else. It used to spread the
    // whole state (items, the full event log, config, stages) plus a copy of
    // the rendered text — tens of kilobytes per poll for the audience told to
    // prefer JSON. briefJson (lib/brief.js) builds the same buckets the text
    // shows, from the same code, so the two views cannot disagree; and a
    // script asking "what is blocked right now" gets ids, titles and the
    // waiting-on fact directly instead of re-deriving them.
    ctx.stdout.write(`${JSON.stringify(briefJson(state, { ...ctx.flags, me, relatedMemory }))}\n`);
  } else ctx.stdout.write(renderBrief(state, { ...ctx.flags, me, relatedMemory }));
}
