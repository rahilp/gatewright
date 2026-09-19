import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, findCycles, missingDeps, stageList, FLAGS } from '../rules.js';
import { isDropped, isTerminalStage, validateStages, resolveRoles } from '../stages.js';
import { vocabDrift } from '../vocab.js';
import { outstandingDispatches } from '../brief.js';
import { triageAdvice } from '../owner.js';

export const spec = { summary: 'report board rule violations', flags: { json: { type: 'boolean' } }, positionals: [] };

// A report is useful until its repeated rows hide every other finding. Keep
// the text-mode per-item lists bounded like `gw brief`; JSON remains complete
// for programs that need every entry.
const TEXT_LIST_LIMIT = 25;

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
    // A check is an audit, not an acknowledgement. Re-baselining here made a
    // one-time warning into a forgery laundromat: a later repair could remove
    // an unrelated corrupt line and inherit the forged baseline. A deliberate
    // repair --write --force is the only way to accept known-stale content.
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

  // T-0071 — the digest proves the board files were not touched since the last
  // gw write; it says nothing about whether what they contain is an item the
  // board can mean. A line of valid JSON carrying stage "nonsense" (an
  // out-of-band write that predated the last `repair --write`, whose digest
  // re-baseline made it look like truth) loaded fine, showed in show and the
  // board, and sailed through here as "Board is clean." Shape is validated
  // independently of digest state. Stage must be a stage this board defines;
  // priority and type are already judged against vocab.* by vocabDrift below.
  const stageIds = new Set(stageList(stages).map((stage) => stage.id));
  for (const item of items) {
    if (!stageIds.has(item.stage)) {
      problems.push(problem('invalid stage', item.id, `stage ${JSON.stringify(item.stage)} is not a stage on this board; the board's stages are ${[...stageIds].join(', ')}. Re-enter it with \`gw move ${item.id} <stage> --force\`, or restore the item from git.`));
    }
    if (item.flag != null && !FLAGS.includes(item.flag)) {
      problems.push(problem('invalid flag', item.id, `flag ${JSON.stringify(item.flag)} is not a flag this board knows; known flags: ${FLAGS.join(', ')}.`));
    }
  }

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
  // `children_done` catches new moves where a board opts into the rule. This
  // independent audit catches parents already hand-edited into a done stage,
  // including boards created before the rule existed.
  if (roles.done) {
    for (const item of items) {
      if (item.stage !== roles.done) continue;
      const openChildren = items.filter((child) => child.parent === item.id && !isTerminalStage(child.stage, stages, roles));
      if (openChildren.length) {
        problems.push(problem('open child', item.id, `done stage ${roles.done} has open child items: ${openChildren.map((child) => `${child.id} (${child.stage})`).join(', ')}. Finish the children or move ${item.id} back out of ${roles.done}.`));
      }
    }
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
    if (isTerminalStage(item.stage, stages, roles)) {
      notes.push(problem('stale triage hold', item.id, `finished in ${item.stage} with a needs-triage hold that no longer needs action: run \`gw repair --write\` to clear it`));
      continue;
    }
    const fix = triageAdvice(item, ctx.actor);
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
      } else if (type === 'stale triage hold') {
        ctx.stdout.write(`STALE TRIAGE HOLD — ${count} finished item${count === 1 ? '' : 's'} still carry a needs-triage hold. Not a violation; run \`gw repair --write\` to tidy them up.\n`);
      } else {
        ctx.stdout.write(`QUEUED DISPATCH — ${count} dispatch${count === 1 ? '' : 'es'} no agent will ever run while the runner is disabled.\n`);
      }
      const shown = entries.slice(0, TEXT_LIST_LIMIT);
      for (const entry of shown) {
        if (type === 'inbox') ctx.stdout.write(`  ${entry.id}: ${entry.fix}\n`);
        else ctx.stdout.write(`  ${entry.id ? `${entry.id}: ` : ''}${entry.fix}\n`);
      }
      if (shown.length < entries.length) ctx.stdout.write(`  (+${entries.length - shown.length} more)\n`);
    }
  }
  return problems.length ? 1 : 0;
  });
}
