import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, nextStage, stageIndex, stageList, stageOrderMessage } from '../rules.js';
import { RuleError, UsageError } from '../cli/errors.js';
import { isTerminalStage, resolveRoles } from '../stages.js';
import { sameOwner, triageAdvice } from '../owner.js';
import { createMemory } from '../memory/provider.js';
import { rememberCompleted } from '../memory/write.js';

export const spec = {
  summary: 'advance an item when its target-stage evidence rule is met',
  flags: { evidence: { type: 'string', repeat: true }, by: { type: 'string' }, force: { type: 'boolean' } },
  positionals: [{ name: 'id', required: true }, { name: 'stage', required: true }],
};

// T-0034 — the recovery advice printed a literal `<side-stage>` placeholder,
// naming no stage that exists. The working path is discoverable and testable:
// park the item in a side stage with --force (side targets are the only moves
// a terminal item may make), then re-enter the pipeline at the furthest stage
// the item still earns. The evaluation simulates the actual re-entry move --
// judged from the parked stage, with the recorded evidence as the pre-move
// baseline -- so the command this message prints is a command that succeeds,
// under the fresh-evidence rule as much as any other.
function recoveryAdvice(id, current, items, stages, roles) {
  const sideStage = [roles.paused, roles.dropped].find((stage) => stage && stage !== current.stage);
  if (!sideStage) return 'run `gw next <id>` to see which moves need --force';
  const pipeline = (stages.stages ?? []).map((stage) => stage.id);
  if (!pipeline.length) return `run \`gw move ${id} ${sideStage} --force\``;
  const parked = { ...current, stage: sideStage };
  const earned = pipeline.filter((stage) => evaluateCumulative(parked, stage, { items, stages, supplied: current.evidence ?? [] }).ok);
  const entry = earned.at(-1) ?? pipeline[0];
  return `run \`gw move ${id} ${sideStage} --force\`, then \`gw move ${id} ${entry} --force\``;
}

export function run(ctx) {
  const [id, to] = ctx.positionals;
  const stages = readStages(ctx.store);
  const roles = resolveRoles(stages);
  const config = readConfig(ctx.store);
  const target = stageList(stages).find((stage) => stage.id === to);

  let completed;
  const result = ctx.store.withLock(() => {
    const items = ctx.store.readItems();
    const index = items.findIndex((candidate) => candidate.id === id);
    if (index < 0) throw new UsageError(`unknown item: ${id}`);
    if (!target) throw new UsageError(`unknown stage: ${to}; valid stages: ${stageList(stages).map((stage) => stage.id).join(', ')}`);
    const current = items[index];
    const sideTarget = stageIndex(stages, to) < 0;
    // T-0010 — this is the board refusing based on item state, exactly like
    // the stage-order and evidence refusals below, so it exits 1 (RuleError)
    // like its siblings instead of 2: the command was well-formed; the item
    // is simply not allowed to move.
    if ((stages.terminal ?? []).includes(current.stage) && (!ctx.flags.force || !sideTarget)) throw new RuleError(`item ${id} is finished in terminal stage ${current.stage}; if this is a mistake, ${recoveryAdvice(id, current, items, stages, roles)}`);
    if (current.stage === to) throw new UsageError(`item ${id} is already in stage ${to}; run \`gw show ${id}\` to inspect it`);

    // T-0072 — claim is the lock, so moving the item must respect it too: a
    // second agent was refused at `claim` yet able to `move` the item out from
    // under its owner with the owner left on it, which is a lock that guards
    // the door but not the windows. An unowned item is unaffected. --force
    // stays available on the move itself as a deliberate one-off, but the
    // honest sequence is taking the item over first, so that is what the
    // refusal names.
    if (current.owner && !sameOwner(current.owner, ctx.actor) && !ctx.flags.force) {
      throw new RuleError(`item ${id} is owned by ${current.owner}, and you are ${ctx.actor}: run \`gw claim ${id} --force\` to take it over first, or pass --force to this move as a deliberate one-off.`);
    }

    // T-0068 — needs-triage describes itself as a hold someone else must lift,
    // yet nothing gated the move: a flagged item could be walked through every
    // stage and arrive at verified still unreviewed. The hold now gates
    // advancement past the initial stage -- capture stays frictionless, which
    // is the point ("rigor at the evidence gate, not the capture gate") --
    // while claim and side-stage moves (dropping or parking unreviewed
    // capture needs no ceremony) stay open. --force remains the recorded
    // override.
    if (current.flag === 'needs-triage' && !ctx.flags.force && !sideTarget && to !== roles.initial) {
      // T-0080: this refusal also surfaces verbatim in the web panel's move
      // strip (T-0018), so like the triage hold it carries a browserMessage
      // that names the decision instead of a command a browser user cannot run.
      const error = new RuleError(`item ${id} is held for triage (flagged needs-triage by ${current.created_by ?? 'an unknown actor'}): ${triageAdvice(current, ctx.actor)} before it advances past ${roles.initial}. Pass --force to move it anyway as a deliberate override.`);
      error.browserMessage = `item ${id} is held for triage (flagged needs-triage by ${current.created_by ?? 'an unknown actor'}): it needs approval before it advances past ${roles.initial}.`;
      throw error;
    }

    // Extras are intentional departures from the linear pipeline. Every other
    // transition has to be exactly one pipeline step unless the caller opts in.
    if (!sideTarget && !ctx.flags.force && nextStage(stages, current.stage) !== to) {
      throw new RuleError(stageOrderMessage(id, current.stage, to, stages));
    }

    // Evidence supplied by this move is part of the proof for entering target.
    // It is recorded with the stage it was supplied for (T-0029), so the gate
    // that accepted it stays auditable and a later gate cannot count it.
    const evidence = (ctx.flags.evidence ?? []).map((text) => String(text).trim()).filter(Boolean);
    const proposed = { ...current, evidence: [...(current.evidence ?? []), ...evidence.map((text) => ({ text, stage: to }))] };
    const verdict = evaluateCumulative(proposed, to, { items, stages, supplied: current.evidence ?? [], actor: ctx.actor });
    if (!verdict.ok) throw new RuleError('target stage requirements are not met', verdict.failures);

    const moved = { ...proposed, stage: to, updated: new Date().toISOString() };
    if (current.stage === roles.paused && moved.flag === 'paused') moved.flag = null;
    // T-0068 — a verified item sitting in brief's NEEDS TRIAGE list is
    // nonsense: whatever else entry to a terminal stage means, it cannot mean
    // "still unreviewed".
    if (moved.flag === 'needs-triage' && isTerminalStage(to, stages, roles)) moved.flag = null;
    items[index] = moved;
    ctx.store.writeItems(items);
    const queuedComment = Boolean(config.github?.enabled && current.gh && config.github?.comment_on_move);
    ctx.store.appendEvent({ type: 'move', item: id, from: current.stage, to, by: ctx.actor, evidence, ...(queuedComment ? { queued_comment: true } : {}) });
    ctx.stdout.write(`${id}  ${current.stage} → ${to}  ·  evidence: ${evidence.join(', ')}\n`);
    if (config.memory?.enabled && config.memory.remember?.on_close && to === config.github?.close_on) completed = { item: moved, from: current.stage, to };
  });
  // A close is one event and receives one independent memory, even if it
  // follows a successful run on the same item.
  if (completed) {
    const memory = createMemory({ config, transport: ctx.memoryTransport, log: { root: ctx.store.root } });
    void rememberCompleted({ memory, root: ctx.store.root, config, ...completed, verified: true });
  }
  return result;
}
