import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { readTemplate } from '../lib/templates.js';
import { pull } from '../lib/sync/pull.js';
import { push } from '../lib/sync/push.js';

// Keep this list explicit. If the item schema gains a field, this test should
// make the ownership decision visible instead of silently treating it as
// "everything else".
const TRACKER_OWNED_FIELDS = [
  'stage', 'flag', 'owner', 'deps', 'evidence', 'notes', 'refs', 'parent',
  'id', 'created_by', 'created', 'updated',
];

const intake = {
  title: 'GitHub title wins',
  body: 'The GitHub-owned scope wins too.',
  labels: [
    { name: 'priority/P1' },
    { name: 'type/defect' },
  ],
  // milestone_to defaults to 'phase' (P0-15 dropped the item field `gate`,
  // and a milestone maps most naturally onto a phase), so this proves the
  // milestone -- not a label -- is what decides phase here.
  milestone: { title: 'P9' },
  state: 'OPEN',
  updatedAt: '2026-09-14T13:00:00Z',
  url: 'https://github.com/owner/repo/issues/42',
};

function item(overrides = {}) {
  return {
    id: 'P3-10', title: 'local title', phase: 'P3', priority: 'P3', type: 'feature',
    stage: 'building', flag: 'blocked', owner: 'human:rahil', scope: 'local scope',
    deps: ['P3-01', 'P3-02'], evidence: ['commit:abc123', 'test:local'],
    notes: 'local notes stay local', refs: ['REQ-9', 'R-42'], parent: 'P3-01', created_by: 'human',
    gh: { number: 42, url: intake.url, updated_at: '2026-09-14T12:00:00Z' },
    created: '2026-09-14T10:00:00.000Z', updated: '2026-09-14T12:30:00.000Z',
    ...overrides,
  };
}

function config() {
  return {
    version: 1,
    id_scheme: 'phase-seq',
    vocab: { phase: ['P3', 'P9'], priority: ['P0', 'P1', 'P2', 'P3'], type: ['feature', 'defect'] },
    github: {
      enabled: true, repo: 'owner/repo', dispatch_label: 'agent/go', close_on: 'verified',
      labels: { 'priority/P1': { priority: 'P1' }, 'type/defect': { type: 'defect' } },
      milestone_to: 'phase',
    },
  };
}

function board(items = [item()], overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-sync-ownership-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, readTemplate('stages.json'));
  writeFileSync(store.paths.config, JSON.stringify({ ...config(), ...overrides }, null, 2) + '\n');
  return store;
}

function issue(overrides = {}) {
  return {
    number: 42,
    ...intake,
    // These are deliberately tracker-shaped keys on the incoming issue. They
    // must remain inert: a careless object spread would overwrite the item.
    stage: 'verified', owner: 'agent:attacker', evidence: ['splat'],
    ...overrides,
  };
}

function gh(issues) {
  return { issues: () => issues };
}

function hashes(store) {
  return [store.paths.items, store.paths.events, store.paths.digest].map((path) => (
    createHash('sha256').update(readFileSync(path)).digest('hex')
  ));
}

test('GitHub sync writes intake only and ignores hostile tracker-shaped issue keys', () => {
  const original = item();
  const store = board([original]);
  pull({ store, gh: gh([issue()]) });
  const updated = store.readItems()[0];

  assert.deepEqual(
    Object.fromEntries(['title', 'scope', 'priority', 'type', 'phase'].map((field) => [field, updated[field]])),
    { title: intake.title, scope: intake.body, priority: 'P1', type: 'defect', phase: 'P9' },
  );
  for (const field of TRACKER_OWNED_FIELDS) {
    assert.equal(JSON.stringify(updated[field]), JSON.stringify(field === 'evidence' ? original[field].map((text) => ({ text, stage: null })) : original[field]), `${field} is tracker-owned`);
  }
});

test('GitHub sync is idempotent, then records exactly one real update', () => {
  const store = board();
  const fixture = issue();
  pull({ store, gh: gh([fixture]) });

  const before = hashes(store);
  const beforeEvents = store.readEvents().length;
  pull({ store, gh: gh([fixture]) });
  assert.deepEqual(hashes(store), before, 'unchanged sync rewrote a data file');
  assert.equal(store.readEvents().length, beforeEvents, 'unchanged sync appended an event');

  const writes = { items: 0, config: 0, events: 0 };
  const originalWriteItems = store.writeItems;
  const originalWriteConfig = store.writeConfig;
  const originalAppendEvent = store.appendEvent;
  store.writeItems = (...args) => { writes.items += 1; return originalWriteItems(...args); };
  store.writeConfig = (...args) => { writes.config += 1; return originalWriteConfig(...args); };
  store.appendEvent = (...args) => { writes.events += 1; return originalAppendEvent(...args); };

  const changed = issue({ title: 'A real GitHub change', updatedAt: '2026-09-14T14:00:00Z' });
  pull({ store, gh: gh([changed]) });
  assert.deepEqual(writes, { items: 1, config: 1, events: 1 });
  assert.equal(store.readItems()[0].title, changed.title);
});

test('closed active issues only raise one conflict flag', () => {
  const store = board([item({ flag: null })]);
  const closed = issue({ state: 'CLOSED', updatedAt: '2026-09-14T12:00:00Z' });
  const before = store.readItems()[0];
  pull({ store, gh: gh([closed]) });
  const after = store.readItems()[0];
  assert.equal(after.flag, 'conflict');
  for (const field of Object.keys(before).filter((field) => field !== 'flag')) {
    assert.equal(JSON.stringify(after[field]), JSON.stringify(before[field]), `${field} changed during conflict`);
  }
  assert.equal(store.readEvents().filter((event) => event.type === 'flag').length, 1);

  pull({ store, gh: gh([closed]) });
  assert.equal(store.readEvents().filter((event) => event.type === 'flag').length, 1);
});

test('push comments, closes, and dispatches without changing any item field', () => {
  const original = item({ stage: 'verified', flag: null });
  const store = board([original]);
  store.appendEvent({ type: 'move', item: original.id, from: 'building', to: 'verified', by: 'agent:r-42', evidence: ['commit:abc'], queued_comment: true });
  const calls = [];
  const fakeGh = {
    comment(number, body) { calls.push(['comment', number, body]); },
    close(number) { calls.push(['close', number]); },
    editLabels(number, options) { calls.push(['labels', number, options]); },
  };

  push({ store, gh: fakeGh, issues: [issue({ labels: ['agent/go'] })] });
  assert.deepEqual(calls.map(([action]) => action), ['comment', 'close', 'labels']);
  // T-0029: the store reads evidence back as `{ text, stage }` entries; the
  // flat fixture strings are the migrated shape, tagged `null` on read.
  const stored = { ...original, evidence: original.evidence.map((text) => ({ text, stage: null })) };
  assert.deepEqual(store.readItems()[0], stored, 'push changed the materialized item');
});

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? jsFiles(path) : (entry.name.endsWith('.js') ? [path] : []);
  });
}

test('sync shelling out is structurally confined to lib/sync/gh.js', () => {
  const syncDir = fileURLToPath(new URL('../lib/sync/', import.meta.url));
  for (const path of jsFiles(syncDir)) {
    // `join` reports OS-native separators (backslashes on Windows), so a
    // forward-slash suffix check would silently never match there.
    if (path.replace(/\\/g, '/').endsWith('/gh.js')) continue;
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /node:child_process|child_process|execFile|spawn|fork/, path);
  }
});
