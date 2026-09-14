import { readFileSync } from 'node:fs';
import { parseMarkdown } from '../import/md.js';
import { evaluateRequires, evaluateCumulative } from '../rules.js';
import { readStages } from '../config.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';

export const spec = {
  summary: 'Import items from a task list file',
  flags: {
    format: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
  positionals: [{ name: 'file', required: true }],
};

function humanReason(failure) {
  return failure
    .replace(/: run `[^`]+`.*$/, '')
    .replace(/\. Move them with `[^`]+`.*$/, '');
}

export function resolveImportStage(item, intendedStageId, { items, stages }) {
  const roles = resolveRoles(stages);
  const targetVerdict = evaluateRequires(item, intendedStageId, { items, stages });
  // Import has only two honest outcomes. In particular, do not walk backward
  // through the pipeline: a stage such as merged can pass its own dependency
  // rule vacuously even when the item has never produced any evidence.
  if (intendedStageId === roles.initial) return { stage: intendedStageId, reason: null };
  const cumulativeVerdict = evaluateCumulative(item, intendedStageId, { items, stages });
  if (cumulativeVerdict.ok) return { stage: intendedStageId, reason: null };
  // Prefer the requested stage's own explanation in the report. This makes a
  // markdown checkmark teach the user about the evidence it is missing, while
  // cumulative evaluation still prevents skipped earlier gates.
  return { stage: roles.initial, reason: targetVerdict.failures[0] ?? cumulativeVerdict.failures[0] };
}

export function resolveImportStages(items, stages) {
  const roles = resolveRoles(stages);
  const byId = new Map(items.map((item) => [item.id, { ...item, intendedStage: roles[item.stage], stage: roles[item.stage] }]));
  const all = () => Array.from(byId.values());

  for (const item of byId.values()) {
    const { stage } = resolveImportStage(item, item.intendedStage, { items: all(), stages });
    item.stage = stage;
  }

  const placed = all();
  const downgrades = [];
  for (const item of placed) {
    if (item.stage !== item.intendedStage) {
      const { reason } = resolveImportStage(
        { ...item, stage: item.intendedStage },
        item.intendedStage,
        { items: placed, stages },
      );
      if (reason) downgrades.push({ id: item.id, source: item.intendedStage, stage: item.stage, reason });
    }
  }

  return { items: placed, downgrades };
}

function printDowngrades(downgrades, stdout, roles) {
  for (const d of downgrades) {
    const sourceDescription = d.source === roles.done ? 'source says done' : `source says ${d.source}`;
    stdout.write(`${d.id}: ${sourceDescription}, imported to ${d.stage} (${d.source} ${humanReason(d.reason)})\n`);
  }
  const doneDowngrades = downgrades.filter((d) => d.source === roles.done);
  if (doneDowngrades.length) {
    stdout.write(`${doneDowngrades.length} item(s) marked done in the source could not enter ${roles.done}; see above.\n`);
  }
}

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

  const stages = readStages(store);
  const roles = resolveRoles(stages);
  const { items: placed, downgrades } = resolveImportStages(items, stages);

  const existing = new Set(store.readItems().map((i) => i.id));
  const collisions = placed.filter((i) => existing.has(i.id)).map((i) => i.id);
  if (collisions.length) {
    throw new RuleError('import would overwrite existing items', collisions);
  }

  if (flags['dry-run']) {
    for (const item of placed) stdout.write(`would import ${item.id}: ${item.title}\n`);
    printDowngrades(downgrades, stdout, roles);
    stdout.write(`would import ${placed.length} item(s), skipped ${skipped.length}\n`);
    return 0;
  }

  store.withLock(() => {
    const current = store.readItems();
    const ids = new Set(current.map((i) => i.id));
    const colliding = placed.filter((i) => ids.has(i.id)).map((i) => i.id);
    if (colliding.length) {
      throw new RuleError('import would overwrite existing items', colliding);
    }

    const now = new Date().toISOString();
    const fullItems = placed.map((item) => ({
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
      evidence: item.evidence ?? [],
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

  printDowngrades(downgrades, stdout, roles);
  stdout.write(`imported ${placed.length}, skipped ${skipped.length}\n`);
  if (skipped.length) {
    for (const s of skipped) {
      stdout.write(`  skipped line ${s.line}: ${s.reason}\n`);
    }
  }
  return 0;
}
