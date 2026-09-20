import { readFileSync } from 'node:fs';
import { parseMarkdown } from '../import/md.js';
import { parseCsv } from '../import/csv.js';
import { parseJson } from '../import/json.js';
import { evaluateRequires, evaluateCumulative } from '../rules.js';
import { readConfig, readStages } from '../config.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { resolveRoles } from '../stages.js';
import { nextId } from '../ids.js';
import { VOCAB_FIELDS } from '../vocab.js';

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
    // T-0047 — this used to cite "specs §6", a file package.json does not
    // ship; the citation was unreachable from an npm install. The message
    // now carries the accepted formats itself, so it cites only what the
    // user actually has: this command.
    return 'no `## P<n> —` phase headings and no `- [ ] task` checklist lines found; gw import reads either format';
  }
  return 'no importable task lines found under the phase headings; task rows look like `- **ID** · title · type · gate · deps · done when`, or use a plain `- [ ] task` checklist';
}

// T-0046 — `gw edit` refuses a dependency on an id that is not on the board;
// an import used to carry one through in silence, and `gw check` was the
// first to mention it. A row whose dependency names neither a board id nor
// another id in this file is skipped with its line and reason, exactly like
// a row with an invalid type: the gate holds at the door, the report says
// why, and the all-rows-skipped failure still fires when nothing valid
// remains.
function enforceDeps(items, knownIds) {
  const kept = [];
  const skipped = [];
  for (const item of items) {
    const unknown = (item.deps ?? []).filter((dep) => !knownIds.has(dep));
    if (unknown.length) {
      skipped.push({ line: item.line, text: item.title, reason: `unknown dependency: ${unknown.join(', ')}` });
      continue;
    }
    kept.push(item);
  }
  return { items: kept, skipped };
}

// T-0134 — the same door, for the same reason, on the field that says what
// an item belongs to. `gw add --parent` refuses an unknown parent outright;
// an import that carried one through would produce a child of nothing, and
// `children_done` would then hold a gate open for a parent no one can find.
//
// Run to a fixpoint, because dropping a row orphans its children: a child of
// a skipped row is a child of nothing just as surely as a child of an id
// that was never in the file, and it gets the same sentence naming the
// parent it cannot have.
function enforceParents(items, availableIds) {
  const skipped = [];
  const dropped = new Set();
  let kept = items;
  for (let changed = true; changed;) {
    changed = false;
    const next = [];
    for (const item of kept) {
      const reason = !item.parent ? null
        : item.parent === item.id ? 'an item cannot be its own parent'
          : (!availableIds.has(item.parent) || dropped.has(item.parent)) ? `unknown parent: ${item.parent}`
            : null;
      if (!reason) { next.push(item); continue; }
      skipped.push({ line: item.line, text: item.title, reason });
      dropped.add(item.id);
      changed = true;
    }
    kept = next;
  }
  return { items: kept, skipped };
}

// Checklist rows (T-0047) carry no id. Mint them from the board's own id
// scheme against the ids already on the board, the same way sync mints ids
// for pulled issues. phase-seq boards need a phase to mint one; a bare
// checklist has none, so that combination is refused with the way out.
function assignIds(items, config, existingIds) {
  const idless = items.filter((item) => !item.id);
  if (!idless.length) return;
  const scheme = config.id_scheme ?? 'phase-seq';
  const pool = [...existingIds].map((id) => ({ id }));
  for (const item of idless) {
    try {
      item.id = nextId(pool, { scheme, phase: item.phase });
    } catch {
      throw new UsageError('checklist rows have no phase, and this board mints ids per phase: set id_scheme to seq with `gw config id_scheme seq`, or add `## P<n> —` headings to the file');
    }
    pool.push({ id: item.id });
  }
}

// One clause per distinct skip reason, naming the lines that failed for it:
// "nothing imported" is only actionable when the message says what was wrong
// with the rows.
function describeSkipped(skipped) {
  const byReason = new Map();
  for (const { line, reason } of skipped) byReason.set(reason, (byReason.get(reason) ?? []).concat(line));
  return [...byReason]
    .map(([reason, lines]) => `${reason}: line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}`)
    .join('; ');
}

// T-0007 — `gw add --phase ZZZ` is refused at the door, so the same value
// through an import must not slip in silently and surface only later in
// `gw check`. Rows carrying a value the vocabulary does not allow -- or a
// title a text table cannot render as one row (T-0009) -- are skipped with a
// reported reason, exactly like rows missing an id or title. Skip rather
// than refuse the whole file because bulk intake is where one malformed row
// among two hundred good ones is normal: holding them hostage makes the
// import useless, while a silent skip would be the exact silence this gate
// exists to remove -- the reasons are printed, and the existing
// all-rows-skipped failure still fires when nothing valid remains.
function enforceVocab(config, items) {
  const kept = [];
  const skipped = [];
  for (const item of items) {
    if (/[\r\n]/.test(item.title)) {
      skipped.push({ line: item.line, text: item.title, reason: 'title must not contain newlines' });
      continue;
    }
    const bad = VOCAB_FIELDS.map((field) => {
      const value = item[field];
      const allowed = config.vocab?.[field];
      if (value === null || value === undefined || !Array.isArray(allowed) || allowed.includes(value)) return null;
      return `invalid ${field} '${value}' (allowed values: ${allowed.join(', ')})`;
    }).find(Boolean);
    if (bad) skipped.push({ line: item.line, text: item.title, reason: bad });
    else kept.push(item);
  }
  return { items: kept, skipped };
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
  const parsed = PARSERS[format](text);
  // A parser that knows why it produced nothing must say so. "imported 0" on
  // its own sends the user looking in the wrong place.
  if (parsed.error) throw new UsageError(parsed.error);

  // The same vocabulary `add` and `edit` enforce at the door (readConfig
  // falls back to the shipped template exactly as those commands do).
  const config = readConfig(store);
  const { items: vocabKept, skipped: vocabSkipped } = enforceVocab(config, parsed.items);

  const boardIds = store.readItems().map((i) => i.id);
  assignIds(vocabKept, config, boardIds);
  const knownIds = new Set([...boardIds, ...vocabKept.map((i) => i.id)]);
  const { items: depKept, skipped: depSkipped } = enforceDeps(vocabKept, knownIds);
  // Judged against the rows that actually survived, not merely the rows the
  // file contained.
  const { items, skipped: parentSkipped } = enforceParents(depKept, new Set([...boardIds, ...depKept.map((i) => i.id)]));
  const skipped = [...parsed.skipped, ...vocabSkipped, ...depSkipped, ...parentSkipped];

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

  // The file had rows and none of them was importable. That is a failure, not
  // a quiet zero: a CI script checking the exit code must not read success
  // from an import that imported nothing, and csv and json must agree on that
  // for the same input shape (a file whose rows all lack, say, an id). A file
  // with no rows at all stays exit 0 -- the empty case above.
  if (items.length === 0) {
    throw new UsageError(`nothing imported from ${file}: all ${skipped.length} row(s) were skipped (${describeSkipped(skipped)})`);
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
    // The dry run exists to preview the report; a skip without its reason is
    // a preview of a count, not of the report.
    for (const s of skipped) stdout.write(`  skipped line ${s.line}: ${s.reason}\n`);
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
      type: item.type,
      stage: item.stage,
      flag: null,
      // T-0061 — a round-tripped dump names the owner its claim recorded, and
      // the building gate requires one; dropping it would downgrade every
      // claimed item for an owner the source plainly named.
      owner: item.owner ?? null,
      scope: item.scope,
      deps: item.deps,
      evidence: item.evidence ?? [],
      // T-0134 — these three were hardcoded empty, so every import silently
      // dropped an item's running notes, the links it points at and the
      // parent it belongs to, on every format, however plainly the file said
      // them. PRD R8 and tasks P1-12 both promise them preserved. A format
      // that cannot express a field (markdown has no notes, refs or parent
      // column) still lands the same empty default it always did.
      notes: item.notes ?? '',
      refs: item.refs ?? [],
      parent: item.parent ?? null,
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
