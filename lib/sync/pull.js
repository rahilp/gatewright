import { readConfig, readStages } from '../config.js';
import { nextId } from '../ids.js';
import { isTerminalStage, resolveRoles } from '../stages.js';

// These are deliberately the only existing-item fields this module can assign.
// Keep tracker-owned state out of this object-shaped boundary.
const INTAKE_FIELDS = ['title', 'scope', 'priority', 'type', 'phase'];
const LABEL_FIELDS = new Set(['priority', 'type', 'phase']);

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean);
}

function acceptsVocab(config, field, value) {
  const values = config.vocab?.[field];
  return !Array.isArray(values) || values.includes(value);
}

function mappedFields(issue, config, warn) {
  const values = {};
  for (const label of labelNames(issue)) {
    const mapping = config.github?.labels?.[label];
    if (!mapping) continue;
    for (const [field, value] of Object.entries(mapping)) {
      if (!LABEL_FIELDS.has(field)) continue;
      if (!acceptsVocab(config, field, value)) {
        warn(`gw sync: label ${JSON.stringify(label)} maps ${field} to ${JSON.stringify(value)}, which is outside config.vocab; keeping the existing value.\n`);
        continue;
      }
      values[field] = value;
    }
  }
  return values;
}

function milestoneField(issue, config, warn) {
  const field = config.github?.milestone_to;
  const title = issue.milestone?.title;
  if (!field || !title || !LABEL_FIELDS.has(field)) return {};
  if (!acceptsVocab(config, field, title)) {
    warn(`gw sync: milestone ${JSON.stringify(title)} maps ${field} outside config.vocab; keeping the existing value.\n`);
    return {};
  }
  return { [field]: title };
}

function intake(issue, config, warn) {
  return {
    title: issue.title ?? '',
    scope: issue.body ?? '',
    ...mappedFields(issue, config, warn),
    ...milestoneField(issue, config, warn),
  };
}

function newer(issue, item) {
  if (!item.gh?.updated_at) return true;
  return Date.parse(issue.updatedAt) > Date.parse(item.gh.updated_at);
}

function same(a, b) {
  return Object.keys(a).every((key) => a[key] === b[key]);
}

function watermark(issues, previous) {
  const latest = issues.reduce((value, issue) => (
    !issue.updatedAt || (value && Date.parse(issue.updatedAt) <= Date.parse(value)) ? value : issue.updatedAt
  ), previous ?? null);
  return latest ?? new Date().toISOString();
}

function newItem(issue, items, config, stages, warn, now) {
  const fields = intake(issue, config, warn);
  const phase = fields.phase ?? config.vocab?.phase?.[0] ?? null;
  const roles = resolveRoles(stages);
  return {
    id: nextId(items, { scheme: config.id_scheme ?? 'phase-seq', phase }),
    title: fields.title,
    scope: fields.scope,
    phase,
    priority: fields.priority ?? null,
    type: fields.type ?? null,
    stage: roles.initial,
    flag: null,
    owner: null,
    deps: [],
    evidence: [],
    notes: '',
    refs: [],
    parent: null,
    created_by: 'github',
    gh: { number: issue.number, url: issue.url, updated_at: issue.updatedAt },
    created: now,
    updated: now,
  };
}

// Pull issues into a board. The caller supplies the wrapper-created `gh` so
// this policy module remains entirely offline-testable.
export function pull({ store, gh, dryRun = false, stdout = process.stdout, stderr = process.stderr }) {
  const config = readConfig(store);
  const stages = readStages(store);
  const github = config.github ?? {};
  const issues = gh.issues({ since: github.last_sync });
  const warnings = [];
  const warn = (message) => warnings.push(message);
  const changes = [];

  const execute = () => {
    const items = store.readItems();
    const nextItems = items.map((item) => ({ ...item }));
    const byNumber = new Map(nextItems.filter((item) => item.gh?.number !== undefined).map((item) => [item.gh.number, item]));
    const events = [];
    let pulled = 0;
    let conflicts = 0;

    for (const issue of issues) {
      let item = byNumber.get(issue.number);
      if (!item) {
        if (String(issue.state).toUpperCase() !== 'OPEN') continue;
        item = newItem(issue, nextItems, config, stages, warn, new Date().toISOString());
        nextItems.push(item);
        byNumber.set(issue.number, item);
        pulled += 1;
        changes.push({ item: item.id, action: 'create' });
        continue;
      }

      if (String(issue.state).toUpperCase() === 'CLOSED' && !isTerminalStage(item.stage, stages) && item.flag !== 'conflict') {
        // The sole sync exception to ownership: closure conflicts with active
        // tracker work and must be surfaced without inventing a stage move.
        item.flag = 'conflict';
        events.push({ type: 'flag', item: item.id, flag: 'conflict', by: 'sync', reason: 'linked GitHub issue is closed while item is non-terminal' });
        conflicts += 1;
        changes.push({ item: item.id, action: 'flag conflict' });
      }

      if (!newer(issue, item)) continue;
      const fields = intake(issue, config, warn);
      const ghFields = { number: item.gh.number, url: issue.url, updated_at: issue.updatedAt };
      if (!same(fields, item) || !same(ghFields, item.gh)) {
        for (const field of INTAKE_FIELDS) if (Object.hasOwn(fields, field)) item[field] = fields[field];
        item.gh = ghFields;
        pulled += 1;
        changes.push({ item: item.id, action: 'update' });
      }
    }

    const nextWatermark = watermark(issues, github.last_sync);
    const watermarkChanged = nextWatermark !== github.last_sync;
    const itemsChanged = changes.length > 0;
    if (dryRun) return { pulled, conflicts, changes, warnings, watermarkChanged, wrote: false };

    if (itemsChanged) store.writeItems(nextItems);
    for (const event of events) store.appendEvent(event);
    if (itemsChanged || watermarkChanged) {
      const nextConfig = structuredClone(config);
      nextConfig.github ??= {};
      nextConfig.github.last_sync = nextWatermark;
      store.writeConfig(nextConfig);
      store.appendEvent({ type: 'sync', pulled, pushed: 0, conflicts });
    }
    return { pulled, conflicts, changes, warnings, watermarkChanged, wrote: itemsChanged || watermarkChanged };
  };
  // withLock itself creates .gatewright/.lock, so dry-run must deliberately
  // stay outside it to honour its no-filesystem-writes contract.
  const result = dryRun ? execute() : store.withLock(execute);

  for (const message of warnings) stderr.write(message);
  if (dryRun) {
    for (const change of changes) stdout.write(`would ${change.action} ${change.item}\n`);
    if (!changes.length && result.watermarkChanged) stdout.write('would update sync watermark\n');
  }
  return result;
}

export { INTAKE_FIELDS };
