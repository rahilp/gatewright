import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, findCycles, missingDeps } from '../rules.js';
import { isDropped, validateStages, resolveRoles } from '../stages.js';
import { vocabDrift } from '../vocab.js';

export const spec = { summary: 'report board rule violations', flags: { json: { type: 'boolean' } }, positionals: [] };

function problem(type, id, fix) { return { type, id, fix }; }

export function run(ctx) {
  return ctx.store.withLock(() => {
  const stages = readStages(ctx.store);
  const stageFindings = validateStages(stages);
  if (stageFindings.length) {
    const problems = stageFindings.map((fix) => problem('stage definition', null, fix));
    if (ctx.flags.json) ctx.stdout.write(`${JSON.stringify({ problems })}\n`);
    else {
      ctx.stdout.write('STAGE DEFINITION\n');
      for (const entry of problems) ctx.stdout.write(`  ${entry.fix}\n`);
    }
    return 1;
  }

  const digest = ctx.store.verifyDigest();
  const problems = [];
  if (digest.status === 'modified') {
    problems.push(problem('out-of-band write', null, `items.jsonl modified outside gw since ${digest.since}`));
    ctx.store.rebaselineDigest();
  } else if (digest.status === 'unknown') ctx.store.rebaselineDigest();

  const items = ctx.store.readItems();
  const config = readConfig(ctx.store);
  const memory = config.memory;
  if (memory) {
    const provider = memory.providers?.[memory.provider] ?? {};
    if (Object.prototype.hasOwnProperty.call(provider, 'token') || Object.prototype.hasOwnProperty.call(memory, 'token')) {
      problems.push(problem('memory token', null, 'move the literal memory token to an environment variable and set memory.providers.<provider>.token_env.'));
    }
  }
  const roles = resolveRoles(stages);
  const terminal = new Set(stages.terminal ?? []);
  // A terminal stage cannot move by definition. Other finished stages are a
  // workflow choice, so their exemption belongs to the project's config.
  const staleExemptStages = new Set(config.check?.stale_exempt_stages ?? []);
  const active = items.filter((item) => (
    !terminal.has(item.stage) && !staleExemptStages.has(item.stage)
  ));
  const byId = new Map(items.map((item) => [item.id, item]));

  // Terminal cards are the most valuable cards to audit: a hand edit to
  // verified must not turn forged completion into a clean board.
  for (const item of items) {
    const verdict = evaluateCumulative(item, item.stage, { items, stages });
    for (const failure of verdict.failures) problems.push(problem('current stage rule', item.id, failure));
  }
  for (const entry of missingDeps(items)) problems.push(problem('missing dependency', entry.id, `add or remove missing dependency: ${entry.missing.join(', ')}`));
  for (const cycle of findCycles(items)) problems.push(problem('dependency cycle', cycle[0], `break dependency cycle: ${cycle.join(' -> ')}`));
  for (const item of items) {
    const dropped = (item.deps ?? []).filter((id) => {
      const dependency = byId.get(id);
      return dependency && isDropped(dependency, roles);
    });
    if (dropped.length) problems.push(problem('dropped dependency', item.id, `replace or remove dropped dependency: ${dropped.join(', ')}`));
  }
  for (const drift of vocabDrift(config, items)) problems.push(problem('vocabulary', null, drift.fix));
  const staleDays = config.check?.stale_days ?? 7;
  const cutoff = Date.now() - staleDays * 86_400_000;
  for (const item of active) {
    if (item.owner && Date.parse(item.updated) < cutoff) problems.push(problem('stale owner', item.id, `record activity with \`gw note ${item.id} "<note>"\` or run \`gw release ${item.id}\``));
    if (item.flag === 'conflict') problems.push(problem('conflict', item.id, 'resolve the linked GitHub issue, then run `gw check`'));
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
