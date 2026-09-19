import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { push } from '../lib/sync/push.js';

const stages = { stages: [{ id: 'backlog' }, { id: 'built', label: 'Built' }, { id: 'verified', label: 'Verified' }] };

function board(item, events = [], github = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-push-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(Array.isArray(item) ? item : [item]);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ github: { enabled: true, repo: 'o/r', dispatch_label: 'agent/go', comment_on_move: true, close_on: 'verified', ...github } }));
  for (const event of events) store.appendEvent(event);
  return store;
}

const linked = (over = {}) => ({ id: 'P3-04', title: 'work', stage: 'built', evidence: [], gh: { number: 42 }, ...over });
const issue = (over = {}) => ({ number: 42, state: 'OPEN', labels: [], ...over });

function fakeGh({ failComment = false, createFails = false, created = { number: 99, html_url: 'https://github.com/o/r/issues/99' } } = {}) {
  const calls = [];
  return {
    calls,
    comment(number, body) { calls.push(['comment', number, body]); if (failComment) throw new Error('temporary'); },
    close(number) { calls.push(['close', number]); },
    editLabels(number, options) { calls.push(['labels', number, options]); },
    createIssue({ title, body }) {
      calls.push(['create', title, body]);
      if (createFails) throw new Error('rate limited');
      return created;
    },
  };
}

test('queued move comment is sent once and acknowledged', () => {
  const store = board(linked(), [{ type: 'move', item: 'P3-04', from: 'backlog', to: 'built', by: 'agent:r-0042', evidence: ['abc123'], queued_comment: true }]);
  const gh = fakeGh();
  push({ store, gh, issues: [issue()] });
  push({ store, gh, issues: [issue()] });
  assert.deepEqual(gh.calls.filter(([action]) => action === 'comment'), [['comment', 42, '→ Built · evidence: abc123 · by agent:r-0042']]);
  assert.equal(store.readEvents().filter((event) => event.type === 'sync').length, 1);
});

test('failed comment remains queued and retries without duplicating after success', () => {
  const store = board(linked(), [{ type: 'move', item: 'P3-04', from: 'backlog', to: 'built', by: 'agent:r-0042', evidence: ['abc123'], queued_comment: true }]);
  const first = fakeGh({ failComment: true });
  push({ store, gh: first, issues: [issue()] });
  assert.equal(store.readEvents().filter((event) => event.type === 'sync').length, 0);
  const second = fakeGh();
  push({ store, gh: second, issues: [issue()] });
  push({ store, gh: second, issues: [issue()] });
  assert.equal(second.calls.filter(([action]) => action === 'comment').length, 1);
});

test('close_on closes open issues once and skips already closed issues', () => {
  const store = board(linked({ id: 'P3-06', stage: 'verified' }));
  const gh = fakeGh();
  push({ store, gh, issues: [issue()] });
  push({ store, gh, issues: [issue()] });
  push({ store, gh, issues: [issue({ state: 'CLOSED' })] });
  assert.deepEqual(gh.calls.filter(([action]) => action === 'close'), [['close', 42]]);
});

test('agent/go dispatches exactly once across two syncs and removes its label', () => {
  const store = board(linked({ id: 'P3-04' }));
  const gh = fakeGh();
  const fixture = issue({ labels: ['agent/go'] });
  push({ store, gh, issues: [fixture] });
  push({ store, gh, issues: [fixture] });
  assert.equal(store.readEvents().filter((event) => event.type === 'dispatch' && event.item === 'P3-04').length, 1);
  assert.equal(gh.calls.filter(([action]) => action === 'labels').length, 1);
});

test('--dry-run performs no wrapper writes or board writes', () => {
  const store = board(linked({ stage: 'verified' }), [{ type: 'move', item: 'P3-04', from: 'backlog', to: 'built', by: 'agent:r-0042', evidence: ['abc123'], queued_comment: true }]);
  const before = JSON.stringify({ items: store.readItems(), events: store.readEvents() });
  const gh = fakeGh();
  push({ store, gh, issues: [issue({ labels: ['agent/go'] })], dryRun: true });
  assert.equal(gh.calls.length, 0);
  assert.equal(JSON.stringify({ items: store.readItems(), events: store.readEvents() }), before);
});


// mirror_children: an agent filed a child while working on a linked issue, so
// the issue's watchers should see it without having to read the board.
const child = (over = {}) => ({ id: 'P3-04.1', title: 'child work', stage: 'backlog', evidence: [], scope: 'do the thing', parent: 'P3-04', created_by: 'agent:r-0042', gh: null, ...over });

test('an agent-created child of a linked parent gets its own issue, once, with provenance', () => {
  const store = board([linked(), child()], [], { mirror_children: true });
  const gh = fakeGh();
  const first = push({ store, gh, issues: [issue()] });
  assert.deepEqual(first.mirrored, ['P3-04.1']);
  const create = gh.calls.find(([action]) => action === 'create');
  assert.equal(create[1], 'child work');
  assert.equal(create[2], 'Opened by agent run r-0042 while working on #42.\n\ndo the thing');

  // The link the child receives is what stops a second run opening a duplicate.
  assert.equal(store.readItems().find((entry) => entry.id === 'P3-04.1').gh.number, 99);
  const second = push({ store, gh, issues: [issue()] });
  assert.deepEqual(second.mirrored, []);
  assert.equal(gh.calls.filter(([action]) => action === 'create').length, 1);
});

test('mirroring is off unless configured, and never fires for human-created or unparented work', () => {
  const off = board([linked(), child()], [], {});
  const ghOff = fakeGh();
  assert.deepEqual(push({ store: off, gh: ghOff, issues: [issue()] }).mirrored, []);
  assert.equal(ghOff.calls.some(([action]) => action === 'create'), false);

  const human = board([linked(), child({ created_by: 'human:rahil' })], [], { mirror_children: true });
  const ghHuman = fakeGh();
  assert.deepEqual(push({ store: human, gh: ghHuman, issues: [issue()] }).mirrored, []);

  // A parent with no issue of its own has nothing to mirror under.
  const unlinked = board([linked({ gh: null }), child()], [], { mirror_children: true });
  const ghUnlinked = fakeGh();
  assert.deepEqual(push({ store: unlinked, gh: ghUnlinked, issues: [issue()] }).mirrored, []);
});

test('a failed issue creation is reported and leaves the child unlinked for the next run', () => {
  const store = board([linked(), child()], [], { mirror_children: true });
  const gh = fakeGh({ createFails: true });
  const result = push({ store, gh, issues: [issue()] });
  assert.deepEqual(result.mirrored, []);
  assert.equal(result.failures[0].action, 'mirror');
  assert.equal(store.readItems().find((entry) => entry.id === 'P3-04.1').gh, null, 'an unlinked child is retried, not silently dropped');
});

test('a create that returns no issue number is a failure, not a silent bad link', () => {
  const store = board([linked(), child()], [], { mirror_children: true });
  const gh = fakeGh({ created: { html_url: 'https://example.invalid' } });
  const result = push({ store, gh, issues: [issue()] });
  assert.equal(result.failures[0].action, 'mirror');
  assert.equal(store.readItems().find((entry) => entry.id === 'P3-04.1').gh, null);
});

test('dry run reports what it would mirror and creates nothing', () => {
  const store = board([linked(), child()], [], { mirror_children: true });
  const gh = fakeGh();
  const result = push({ store, gh, issues: [issue()], dryRun: true });
  assert.deepEqual(result.mirrored, ['P3-04.1']);
  assert.equal(gh.calls.some(([action]) => action === 'create'), false);
  assert.equal(store.readItems().find((entry) => entry.id === 'P3-04.1').gh, null);
});
