import { readFileSync } from 'node:fs';
import { parseMarkdown } from '../import/md.js';
import { UsageError, RuleError } from '../cli/errors.js';

export const spec = {
  summary: 'Import items from a task list file',
  flags: {
    format: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  positionals: [{ name: 'file', required: true }],
};

export async function run(ctx) {
  const { store, positionals, flags, actor, stdout } = ctx;
  const format = flags.format || 'md';
  if (format !== 'md') throw new UsageError(`unsupported import format: ${format}`);

  const file = positionals[0];
  const text = readFileSync(file, 'utf8');
  const { items, skipped } = parseMarkdown(text);

  if (items.length === 0 && skipped.length === 0) {
    stdout.write('nothing to import\n');
    return 0;
  }

  store.ensure();

  const existing = new Set(store.readItems().map((i) => i.id));
  const collisions = items.filter((i) => existing.has(i.id)).map((i) => i.id);
  if (collisions.length) {
    throw new RuleError('import would overwrite existing items', collisions);
  }

  if (flags['dry-run']) {
    for (const item of items) stdout.write(`would import ${item.id}: ${item.title}\n`);
    stdout.write(`would import ${items.length} item(s), skipped ${skipped.length}\n`);
    return 0;
  }

  store.withLock(() => {
    const current = store.readItems();
    const ids = new Set(current.map((i) => i.id));
    const colliding = items.filter((i) => ids.has(i.id)).map((i) => i.id);
    if (colliding.length) {
      throw new RuleError('import would overwrite existing items', colliding);
    }

    const now = new Date().toISOString();
    const fullItems = items.map((item) => ({
      id: item.id,
      title: item.title,
      phase: item.phase,
      priority: item.priority,
      gate: item.gate,
      type: item.type,
      stage: item.stage,
      flag: null,
      owner: null,
      scope: item.scope,
      deps: item.deps,
      evidence: [],
      notes: '',
      refs: [],
      parent: null,
      created_by: actor,
      gh: null,
      created: now,
      updated: now,
    }));

    store.writeItems(current.concat(fullItems));
    for (const item of fullItems) {
      store.appendEvent({ type: 'add', item: item.id, by: actor, parent: item.parent });
    }
  });

  stdout.write(`imported ${items.length}, skipped ${skipped.length}\n`);
  if (skipped.length) {
    for (const s of skipped) {
      stdout.write(`  skipped line ${s.line}: ${s.reason}\n`);
    }
  }
  return 0;
}
