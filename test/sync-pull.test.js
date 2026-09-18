import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { readTemplate } from '../lib/templates.js';
import { pull } from '../lib/sync/pull.js';
import { runRouter } from '../lib/cli/router.js';

function board({ items = [], stages, config } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-sync-pull-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages ?? JSON.parse(readTemplate('stages.json'))));
  writeFileSync(store.paths.config, JSON.stringify(config ?? {
    version: 1,
    id_scheme: 'phase-seq',
    vocab: { phase: ['P3', 'P9'], priority: ['P0', 'P1', 'P2', 'P3'], type: ['feature', 'defect'] },
    // milestone_to defaults to 'phase' (P0-15 dropped the item field `gate`),
    // so a milestone -- not a label -- decides phase here.
    github: { enabled: true, repo: 'owner/repo', labels: { 'priority/P1': { priority: 'P1' }, 'type/defect': { type: 'defect' } }, milestone_to: 'phase' },
  }));
  return store;
}

function issue(over = {}) {
  return {
    number: 42, title: 'From GitHub', body: 'Done means it works.',
    labels: [{ name: 'priority/P1' }, { name: 'type/defect' }],
    milestone: { title: 'P9' }, state: 'OPEN', updatedAt: '2026-09-14T12:00:00Z', url: 'https://github.com/owner/repo/issues/42', ...over,
  };
}

function gh(issues) { return { issues: () => issues }; }
function hash(store) {
  return [store.paths.items, store.paths.events, store.paths.digest].map((path) => createHash('sha256').update(readFileSync(path)).digest('hex'));
}
function item(over = {}) {
  return {
    id: 'P3-01', title: 'Old title', phase: 'P3', priority: 'P3', type: 'feature',
    stage: 'building', flag: 'blocked', owner: 'agent:r-1', scope: 'old scope', deps: ['P3-00'], evidence: ['abc'], notes: 'local note', refs: ['R1'], parent: null, created_by: 'human',
    gh: { number: 42, url: 'https://github.com/owner/repo/issues/42', updated_at: '2026-09-14T11:00:00Z' }, created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z', ...over,
  };
}

test('new open issues are created at the initial role and unknown closed issues are ignored', () => {
  const store = board();
  pull({ store, gh: gh([issue(), issue({ number: 43, state: 'CLOSED' })]) });
  const items = store.readItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].created_by, 'github');
  assert.equal(items[0].stage, 'backlog');
  assert.equal(items[0].gh.number, 42);
});

test('existing items merge intake fields only and preserve tracker-owned fields byte-for-byte', () => {
  const original = item(); const store = board({ items: [original] });
  pull({ store, gh: gh([issue()]) });
  const updated = store.readItems()[0];
  assert.equal(updated.title, 'From GitHub'); assert.equal(updated.scope, 'Done means it works.');
  assert.equal(updated.priority, 'P1'); assert.equal(updated.type, 'defect'); assert.equal(updated.phase, 'P9', 'the milestone, not a label, decides phase');
  for (const field of ['stage', 'flag', 'owner', 'deps', 'evidence', 'notes', 'refs', 'id', 'created_by', 'parent', 'created', 'updated']) {
    // Evidence entries are `{ text, stage }` in the store (T-0029); the flat
    // fixture string is the migrated shape and reads back tagged `null`.
    const expected = field === 'evidence' ? original[field].map((text) => ({ text, stage: null })) : original[field];
    assert.deepEqual(updated[field], expected, `${field} is tracker-owned`);
  }
});

test('a closed issue flags an active item once without moving it', () => {
  const store = board({ items: [item({ flag: null })] });
  const closed = issue({ state: 'CLOSED' });
  pull({ store, gh: gh([closed]) });
  assert.equal(store.readItems()[0].flag, 'conflict');
  assert.equal(store.readItems()[0].stage, 'building');
  assert.equal(store.readEvents().filter((event) => event.type === 'flag').length, 1);
  pull({ store, gh: gh([closed]) });
  assert.equal(store.readEvents().filter((event) => event.type === 'flag').length, 1);
});

test('an out-of-vocabulary label warns and leaves the old value intact', () => {
  const config = {
    version: 1, id_scheme: 'phase-seq',
    vocab: { phase: ['P3', 'P9'], priority: ['P0', 'P1', 'P2', 'P3'], type: ['feature', 'defect'] },
    github: { enabled: true, repo: 'owner/repo', labels: { 'priority/bad': { priority: 'not-a-priority' } }, milestone_to: 'phase' },
  };
  const store = board({ items: [item()], config }); let stderr = '';
  pull({ store, gh: gh([issue({ labels: [{ name: 'priority/bad' }] })]), stderr: { write: (text) => { stderr += text; } } });
  assert.equal(store.readItems()[0].priority, 'P3');
  assert.match(stderr, /priority\/bad.*priority/);
});

test('an unchanged second sync performs zero data writes and appends zero events', () => {
  const store = board({ items: [item()] }); const fixture = issue();
  pull({ store, gh: gh([fixture]) });
  const before = hash(store); const events = store.readEvents().length;
  pull({ store, gh: gh([fixture]) });
  assert.deepEqual(hash(store), before);
  assert.equal(store.readEvents().length, events);
});

// A sync advances the watermark and writes config.json through
// store.writeConfig. That is gw's own write, so it must re-baseline the
// digest instead of being reported as tampering by the next check.
test('a sync that advances the watermark keeps gw check clean', async () => {
  const store = board();
  const result = pull({ store, gh: gh([issue()]) });
  assert.equal(result.watermarkChanged, true);
  assert.equal(store.verifyDigest().status, 'clean');
  let stdout = '';
  const code = await runRouter(['check'], { cwd: store.root, env: {}, stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} } });
  assert.equal(code, 0);
  assert.equal(stdout, 'Board is clean.\n');
});

test('--dry-run prints item changes while leaving the board untouched', () => {
  const store = board(); let stdout = '';
  const before = hash(store);
  pull({ store, gh: gh([issue()]), dryRun: true, stdout: { write: (text) => { stdout += text; } } });
  assert.deepEqual(hash(store), before);
  assert.match(stdout, /would create P9-01/);
});

test('a custom pipeline uses its initial role rather than a hardcoded backlog', () => {
  const store = board({ stages: { stages: [{ id: 'icebox', role: 'initial' }, { id: 'shipped' }], terminal: ['shipped'], extra: [] } });
  pull({ store, gh: gh([issue()]) });
  assert.equal(store.readItems()[0].stage, 'icebox');
});

test('gw sync receives its injected executor through runRouter and never needs real gh', async () => {
  const store = board();
  const calls = [];
  const code = await runRouter(['sync'], {
    cwd: store.root,
    env: {},
    stdout: { write() {} },
    stderr: { write() {} },
    ghRun: (argv) => {
      calls.push(argv);
      return { status: 0, stdout: JSON.stringify([issue()]) };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [[
    'issue', 'list', '--repo', 'owner/repo', '--state', 'all', '--search', 'updated:>=1970-01-01T00:00:00Z',
    '--json', 'number,title,body,labels,milestone,state,updatedAt,url', '--limit', '200',
  ]]);
  assert.equal(store.readItems().length, 1);
});
