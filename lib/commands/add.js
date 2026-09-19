import { readConfig, readStages } from '../config.js';
import { nextId } from '../ids.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';
import { validateVocab } from '../vocab.js';
import { captureFlag } from '../triage-policy.js';

export const spec = { summary: 'create an item', flags: { parent: { type: 'string' }, type: { type: 'string' }, phase: { type: 'string' }, priority: { type: 'string' }, scope: { type: 'string' }, by: { type: 'string' } }, positionals: [{ name: 'title', required: true }] };

const vocabFields = ['type', 'phase', 'priority'];

function parentDepth(parent, items) {
  const byId = new Map(items.map((item) => [item.id, item])); let depth = 0; let current = parent; const seen = new Set();
  while (current) { if (seen.has(current.id)) return Infinity; seen.add(current.id); depth += 1; current = current.parent ? byId.get(current.parent) : null; }
  return depth;
}

export function run(ctx) {
  const { store, flags, actor, positionals } = ctx;
  const title = positionals[0];
  if (!title.trim()) throw new UsageError('title must not be empty');
  if (/[\r\n]/.test(title)) throw new UsageError('title must not contain newlines');
  if (title.length > 120) throw new UsageError('title must be 120 characters or fewer');
  return store.withLock(() => {
    store.ensure();
    const items = store.readItems(); const config = readConfig(store);
    const roles = resolveRoles(readStages(store));
    validateVocab(config, flags, vocabFields);
    const parent = flags.parent ? items.find((item) => item.id === flags.parent) : null;
    if (flags.parent && !parent) throw new UsageError(`unknown parent item: ${flags.parent}`);
    if (actor.startsWith('agent:') && parent) {
      const children = items.filter((item) => item.parent === parent.id);
      if (children.length >= (config.policy?.max_children_per_item ?? 10)) throw new RuleError(`parent ${parent.id} has reached max_children_per_item (${config.policy?.max_children_per_item ?? 10})`);
    }
    if (parent && parentDepth(parent, items) >= (config.policy?.max_depth ?? 3)) throw new RuleError(`max_depth (${config.policy?.max_depth ?? 3}) reached by parent ${parent.id}`);
    // Rigor belongs at the evidence gate, not at capture: a scheme that does
    // not need a phase to mint an id (the `seq` default) must not invent one.
    // phase-seq still requires a phase; nextId is the one place that refuses.
    const phase = flags.phase ?? (parent?.phase) ?? null;
    const id = nextId(items, { scheme: config.id_scheme ?? 'phase-seq', phase, parent: flags.parent });
    const now = new Date().toISOString();
    // T-0052 — created_by records the actor itself now that actor() always
    // qualifies it (agent:<name> / human:<name>): a bare `--by rahil` used to
    // collapse to the bare word "human" here, losing the name. The actor
    // space is uniform, so provenance is the actor, full stop.
    const item = { id, title, phase, priority: flags.priority ?? null, type: flags.type ?? null, stage: roles.initial, flag: null, owner: null, scope: flags.scope ?? '', deps: [], evidence: [], notes: '', refs: [], parent: flags.parent ?? null, created_by: actor, gh: null, created: now, updated: now };
    // Unclassified intake is a visible state, not a silent default: an item
    // with no phase, type or priority looks fully specified unless flagged.
    // The `unclassified` flag only holds the item off the *scheduler's*
    // eligibility list (see lib/policy.js isSchedulable) and lists it in the
    // triage inbox -- claim and move never consult it, so whoever created it
    // can still pick it up and work it with no extra step (T-0113).
    //
    // Agent-created work keeps its existing, separately-configured rule
    // (policy.triage_required_for / auto_dispatch_children) unchanged --
    // auto_dispatch_children exists precisely so a bounded, policy-approved
    // chain of agent-created children is never held, classified or not.
    // That rule sets needs-triage, which move does refuse, and it wins over
    // the capture flag when both apply.
    item.flag = captureFlag(item, actor, config);
    store.writeItems([...items, item]); store.appendEvent({ type: 'add', item: id, by: actor, parent: item.parent });
    ctx.stdout?.write(`${id}\n`);
  });
}
