import { readConfig } from '../config.js';
import { nextId } from '../ids.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { validateVocab } from '../vocab.js';

export const spec = { summary: 'create an item', flags: { parent: { type: 'string' }, type: { type: 'string' }, phase: { type: 'string' }, priority: { type: 'string' }, gate: { type: 'string' }, scope: { type: 'string' }, by: { type: 'string' } }, positionals: [{ name: 'title', required: true }] };

const vocabFields = ['type', 'phase', 'priority', 'gate'];

export function run(ctx) {
  const { store, flags, actor, positionals } = ctx;
  const title = positionals[0];
  if (title.length > 120) throw new UsageError('title must be 120 characters or fewer');
  return store.withLock(() => {
    store.ensure();
    const items = store.readItems(); const config = readConfig(store);
    validateVocab(config, flags, vocabFields);
    const parent = flags.parent ? items.find((item) => item.id === flags.parent) : null;
    if (flags.parent && !parent) throw new UsageError(`unknown parent item: ${flags.parent}`);
    if (actor.startsWith('agent:') && parent) {
      const children = items.filter((item) => item.parent === parent.id);
      if (children.length >= (config.policy?.max_children_per_item ?? 10)) throw new RuleError(`parent ${parent.id} has reached max_children_per_item (${config.policy?.max_children_per_item ?? 10})`);
    }
    const phase = flags.phase ?? 'P1';
    const id = nextId(items, { scheme: config.id_scheme ?? 'phase-seq', phase, parent: flags.parent });
    const now = new Date().toISOString();
    const item = { id, title, phase, priority: flags.priority ?? null, gate: flags.gate ?? null, type: flags.type ?? null, stage: 'backlog', flag: null, owner: null, scope: flags.scope ?? '', deps: [], evidence: [], notes: '', refs: [], parent: flags.parent ?? null, created_by: actor.startsWith('agent:') ? actor : 'human', gh: null, created: now, updated: now };
    if (actor.startsWith('agent:') && parent && (config.policy?.triage_required_for ?? []).includes('agent') && !config.policy?.auto_dispatch_children) item.flag = 'needs-triage';
    store.writeItems([...items, item]); store.appendEvent({ type: 'add', item: id, by: actor, parent: item.parent });
    ctx.stdout?.write(`${id}\n`);
  });
}
