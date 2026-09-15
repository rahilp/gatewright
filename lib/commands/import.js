import { readFileSync } from 'node:fs';
import { parseMarkdown } from '../import/md.js';
import { parseCsv } from '../import/csv.js';
import { parseJson } from '../import/json.js';
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

const PARSERS = { md: parseMarkdown, csv: parseCsv, json: parseJson };

// The extension is a better default than assuming markdown: passing a .csv
// and getting "no phase headings found" is a confusing way to learn that a
// flag exists.
function inferFormat(file) {
  const extension = String(file ?? '').toLowerCase().match(/\.([a-z]+)$/)?.[1];
  if (extension === 'csv') return 'csv';
  if (extension === 'json') return 'json';
  return 'md';
}

function humanReason(failure) {
  return failure
    .replace(/: run `[^`]+`.*$/, '')
    .replace(/\. Move them with `[^`]+`.*$/, '');
}

function emptyImportMessage(text) {
  if (!/^##\s+P\d+\b/m.test(text)) {
    return 'no `## P<n> —` phase headings found; see specs §6 for the expected format';
  }
  return 'no importable task lines found under phase headings; see specs §6 for the expected format';
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
  // A source may name a role ("initial", "done" -- what the markdown parser
  // emits) or a real stage id ("built" -- what a CSV status column or a
  // `gw list --json` dump contains). Both are legitimate; a name that is
  // neither is placed at the initial stage rather than crashing on an
  // undefined lookup, and the downgrade report explains it.
  const known = new Set([...(stages.stages ?? []), ...(stages.extra ?? [])].map((stage) => stage.id));
  const intendedFor = (name) => roles[name] ?? (known.has(name) ? name : roles.initial);
  const byId = new Map(items.map((item) => [item.id, { ...item, intendedStage: intendedFor(item.stage), stage: intendedFor(item.stage) }]));
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
  const format = flags.format || inferFormat(positionals[0]);
  if (!PARSERS[format]) throw new UsageError(`unsupported import format: ${format}; use md, csv, or json`);

  const file = positionals[0];
  const text = readFileSync(file, 'utf8');
  const { items, skipped, error } = PARSERS[format](text);
  // A parser that knows why it produced nothing must say so. "imported 0" on
  // its own sends the user looking in the wrong place.
  if (error) throw new UsageError(error);

  if (items.length === 0 && skipped.length === 0) {
    if (format !== 'md') {
      stdout.write(`no importable rows found in ${file}\n`);
      return 0;
    }
    const message = emptyImportMessage(text);
    if (!/^##\s+P\d+\b/m.test(text)) throw new UsageError(message);
    stdout.write(`${message}\n`);
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
