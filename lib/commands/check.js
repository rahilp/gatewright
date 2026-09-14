import { readConfig, readStages } from '../config.js';
import { evaluateRequires, findCycles, missingDeps } from '../rules.js';

export const spec = { summary: 'report board rule violations', flags: { json: { type: 'boolean' } }, positionals: [] };

function problem(type, id, fix) { return { type, id, fix }; }

export function run(ctx) {
  return ctx.store.withLock(() => {
  const digest = ctx.store.verifyDigest();
  const problems = [];
  if (digest.status === 'modified') {
    problems.push(problem('out-of-band write', null, `items.jsonl modified outside gw since ${digest.since}`));
    ctx.store.rebaselineDigest();
  } else if (digest.status === 'unknown') ctx.store.rebaselineDigest();

  const items = ctx.store.readItems();
  const stages = readStages(ctx.store);
  const config = readConfig(ctx.store);
  const terminal = new Set(stages.terminal ?? []);
  // The stock workflow treats merged as finished too, even though only
  // verified/dropped are listed as terminal states for transition purposes.
  const active = items.filter((item) => !terminal.has(item.stage) && item.stage !== 'merged');
  const byId = new Map(items.map((item) => [item.id, item]));

  // Terminal cards are the most valuable cards to audit: a hand edit to
  // verified must not turn forged completion into a clean board.
  for (const item of items) {
    const verdict = evaluateRequires(item, item.stage, { items, stages });
    for (const failure of verdict.failures) problems.push(problem('current stage rule', item.id, failure));
  }
  for (const entry of missingDeps(items)) problems.push(problem('missing dependency', entry.id, `add or remove missing dependency: ${entry.missing.join(', ')}`));
  for (const cycle of findCycles(items)) problems.push(problem('dependency cycle', cycle[0], `break dependency cycle: ${cycle.join(' -> ')}`));
  for (const item of items) {
    const dropped = (item.deps ?? []).filter((id) => byId.get(id)?.stage === 'dropped');
    if (dropped.length) problems.push(problem('dropped dependency', item.id, `replace or remove dropped dependency: ${dropped.join(', ')}`));
  }
  const staleDays = config.check?.stale_days ?? 7;
  const cutoff = Date.now() - staleDays * 86_400_000;
  for (const item of active) {
    if (item.owner && Date.parse(item.updated) < cutoff) problems.push(problem('stale owner', item.id, `record activity or release owner ${item.owner}`));
    if (item.flag === 'conflict') problems.push(problem('conflict', item.id, 'resolve the linked GitHub issue conflict'));
  }

  if (ctx.flags.json) ctx.stdout.write(`${JSON.stringify({ problems })}\n`);
  else if (!problems.length) ctx.stdout.write('Board is clean.\n');
  else {
    const groups = new Map();
    for (const entry of problems) (groups.get(entry.type) ?? groups.set(entry.type, []).get(entry.type)).push(entry);
    for (const [type, entries] of groups) {
      ctx.stdout.write(`${type.toUpperCase()}\n`);
      for (const entry of entries) ctx.stdout.write(`  ${entry.id ? `${entry.id}: ` : ''}${entry.fix}\n`);
    }
  }
  return problems.length ? 1 : 0;
  });
}
