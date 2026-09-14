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
  store.writeItems([item]);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ github: { enabled: true, repo: 'o/r', dispatch_label: 'agent/go', comment_on_move: true, close_on: 'verified', ...github } }));
  for (const event of events) store.appendEvent(event);
  return store;
}

const linked = (over = {}) => ({ id: 'P3-04', title: 'work', stage: 'built', evidence: [], gh: { number: 42 }, ...over });
const issue = (over = {}) => ({ number: 42, state: 'OPEN', labels: [], ...over });

function fakeGh({ failComment = false } = {}) {
  const calls = [];
  return {
    calls,
    comment(number, body) { calls.push(['comment', number, body]); if (failComment) throw new Error('temporary'); },
    close(number) { calls.push(['close', number]); },
    editLabels(number, options) { calls.push(['labels', number, options]); },
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

