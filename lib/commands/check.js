import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, findCycles, missingDeps } from '../rules.js';
import { isDropped, validateStages, resolveRoles } from '../stages.js';
import { vocabDrift } from '../vocab.js';
import { outstandingDispatches } from '../brief.js';

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
  // Reported to the reader, never counted toward the exit code.
  const notes = [];
  if (digest.status === 'modified') {
    for (const file of digest.files) problems.push(problem('out-of-band write', null, `${file} modified outside gw since ${digest.since}`));
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
  // needs-triage is silent by design in the scheduler (see lib/policy.js
  // isSchedulable) so an autonomous run never snowballs unreviewed work, but
  // silent everywhere is how an untriaged item rots on the board unseen.
  // `check` is where it surfaces.
  //
  // Reported, but NOT counted as a violation until it goes stale. An inbox is
  // not a defect: this command runs in CI (see .github/workflows/
  // gatewright.yml), so failing on a fresh capture would mean jotting an idea
  // breaks the build and you must classify it before you may commit --
  // exactly the ceremony that capturing in one command exists to remove. An
  // item nobody has classified in stale_days is a different thing, and that
  // does fail.
  for (const item of items) {
    if (item.flag !== 'needs-triage') continue;
    const fix = `classify with \`gw edit ${item.id} --phase P --type T --priority P\`, or claim and work it as-is with \`gw claim ${item.id}\``;
    const rotted = Date.parse(item.updated) < cutoff;
    (rotted ? problems : notes).push(problem(rotted ? 'needs triage' : 'inbox', item.id, rotted ? `untriaged for over ${staleDays} days: ${fix}` : fix));
  }

  // T-0019 — a dispatch queued while runner.enabled is false can never run:
  // no scheduler will ever record the run_ended that would clear it, so the
  // item sits in its queued state forever. Reported as a note, like the
  // inbox: queueing work is a legitimate choice, but only if it is a visible
  // one.
  if (!config.runner?.enabled) {
    for (const id of outstandingDispatches(ctx.store.readEvents())) {
      notes.push(problem('queued dispatch', id, 'queued while runner.enabled is false, so no agent will ever pick it up: enable it with `gw config runner.enabled true` and start the scheduler with `gw serve`, or cancel the dispatch from the board'));
    }
  }

  if (ctx.flags.json) ctx.stdout.write(`${JSON.stringify({ problems, notes })}\n`);
  else if (!problems.length && !notes.length) ctx.stdout.write('Board is clean.\n');
  if (!ctx.flags.json && problems.length) {
    const groups = new Map();
    for (const entry of problems) (groups.get(entry.type) ?? groups.set(entry.type, []).get(entry.type)).push(entry);
    for (const [type, entries] of groups) {
      ctx.stdout.write(`${type.toUpperCase()}\n`);
      for (const entry of entries) ctx.stdout.write(`  ${entry.id ? `${entry.id}: ` : ''}${entry.fix}\n`);
    }
  }
  // Notes are printed after any problems and never change the exit code.
  // Each note type gets its own heading: an inbox and a stranded dispatch
  // are different things a reader acts on differently.
  if (!ctx.flags.json && notes.length) {
    const groups = new Map();
    for (const entry of notes) (groups.get(entry.type) ?? groups.set(entry.type, []).get(entry.type)).push(entry);
    for (const [type, entries] of groups) {
      const count = entries.length;
      if (type === 'inbox') {
        ctx.stdout.write(`INBOX — ${count} item${count === 1 ? '' : 's'} not classified yet. Not a violation; nothing to do unless you want to.\n`);
      } else {
        ctx.stdout.write(`QUEUED DISPATCH — ${count} dispatch${count === 1 ? '' : 'es'} no agent will ever run while the runner is disabled.\n`);
      }
      for (const entry of entries) ctx.stdout.write(`  ${entry.id ? `${entry.id}: ` : ''}${entry.fix}\n`);
    }
  }
  return problems.length ? 1 : 0;
  });
}
