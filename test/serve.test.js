import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { readConfig } from '../lib/config.js';
import { createServeServer, listen } from '../lib/serve/server.js';

const item = { id: 'P1-01', title: 'Live board', phase: 'P1', priority: 'P1', gate: 'G0', type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '', deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };

async function withServer(fn, { items = [item], stages } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-'));
  const store = createStore(root); store.ensure(); store.writeItems(items);
  if (stages) writeFileSync(store.paths.stages, JSON.stringify(stages));
  store.appendEvent({ ts: '2026-01-01T00:00:00.000Z', type: 'add', item: item.id, by: 'human' });
  store.appendEvent({ ts: '2026-01-02T00:00:00.000Z', type: 'move', item: item.id, by: 'human', from: 'backlog', to: 'specified' });
  const server = createServeServer({ store }); const address = await listen(server, { port: 0 });
  try { await fn({ store, url: `http://127.0.0.1:${address.port}` }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function fakeClock() {
  let now = 0; let next = 1; const timers = new Map();
  return {
    now: () => now,
    jump(ms) { now += ms; },
    setTimeout(fn, delay) { const id = next++; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= now).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        for (const [id, timer] of due) { if (timers.delete(id)) await timer.fn(); }
        await Promise.resolve();
      }
    },
  };
}

function configureGithub(store, over = {}) {
  const config = readConfig(store);
  config.github = { ...config.github, enabled: true, repo: 'owner/repo', sync_interval_min: 1, ...over };
  writeFileSync(store.paths.config, JSON.stringify(config));
}

function write(url, path, body) {
  return fetch(url + path, {
    method: 'POST',
    headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function transitions(url, id = 'P1-01') {
  return fetch(url + '/api/items/' + encodeURIComponent(id) + '/transitions');
}

test('serve returns state, filters events, serves an empty-shell viewer, and refuses unknown paths', async () => {
  await withServer(async ({ url }) => {
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.items[0].id, 'P1-01'); assert.equal(state.events.length, 2); assert.ok(state.generatedAt);
    assert.equal('transitions' in state.items[0], false);
    const since = await (await fetch(url + '/api/state?since=2026-01-01T12:00:00.000Z')).json();
    assert.equal(since.events.length, 1); assert.equal(since.events[0].type, 'move');
    const shell = await (await fetch(url + '/')).text();
    assert.match(shell, /fetch\('\/api\/state'\)/); assert.doesNotMatch(shell, /id="gw-items"/);
    assert.equal((await fetch(url + '/../../etc/passwd')).status, 404);
    assert.equal((await fetch(url + '/nope')).status, 404);
  });
});

test('state transitions reject a skipped earlier gate even when the immediate target passes', async () => {
  const stages = {
    stages: [
      { id: 'backlog' }, { id: 'building', requires: { owner: true } },
      { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
    ],
    terminal: [], extra: [],
  };
  // The old browser mirror checked only in_review, which this PR evidence
  // satisfies. The unearned building owner gate must still refuse the move.
  const progressed = { ...item, stage: 'built', owner: null, evidence: ['https://github.com/a/b/pull/1'] };
  await withServer(async ({ url }) => {
    const transition = (await (await transitions(url)).json()).in_review;
    const response = await write(url, '/api/items/P1-01/move', { to: 'in_review', evidence: [] });
    assert.equal(response.status, 409);
    assert.equal(transition.ok, false);
    assert.deepEqual(transition.failures, (await response.json()).failures);
    assert.match(transition.failures.join('\\n'), /building: needs an owner/);
    assert.equal(transition.failures.length, 1);
  }, { items: [progressed], stages });
});

test('state offers side stages and marks force-only pipeline jumps', async () => {
  const stages = {
    stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'built' }],
    terminal: [], extra: [{ id: 'dropped' }, { id: 'paused' }],
  };
  await withServer(async ({ url }) => {
    const result = await (await transitions(url)).json();
    assert.deepEqual(result.specified, { ok: true, failures: [] });
    assert.deepEqual(result.dropped, { ok: true, failures: [] });
    assert.deepEqual(result.paused, { ok: true, failures: [] });
    assert.deepEqual(result.built, { ok: true, failures: [], force: true });
  }, { stages });

  await withServer(async ({ url }) => {
    const result = await (await transitions(url)).json();
    assert.equal('dropped' in result, false);
    assert.equal('paused' in result, false);
  }, { stages: { stages: [{ id: 'backlog' }, { id: 'specified' }], terminal: [], extra: [] } });
});

test('state does not broadcast transitions and the per-item endpoint handles unknown ids', async () => {
  await withServer(async ({ url }) => {
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal('transitions' in state.items[0], false);
    assert.equal((await transitions(url, 'missing')).status, 404);
    assert.equal((await transitions(url)).status, 200, 'GET works without an Origin header');
  });
});

test('viewer has no client-side requirement evaluator and retains snapshot fallback', () => {
  const viewer = readFileSync(new URL('../viewer/board.html', import.meta.url), 'utf8');
  assert.doesNotMatch(viewer, /evaluateRequires/);
  assert.match(viewer, /read-only snapshot/);
  assert.match(viewer, /!State\.live/);
});

test('serve rejects a non-loopback Origin and does not write board data', async () => {
  await withServer(async ({ store, url }) => {
    const digest = () => createHash('sha256').update(readFileSync(store.paths.items)).update(readFileSync(store.paths.events)).update(readFileSync(store.paths.digest)).digest('hex');
    const before = digest();
    assert.equal((await fetch(url + '/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
    await fetch(url + '/'); await fetch(url + '/api/state');
    assert.equal(digest(), before);
  });
});

test('scheduled GitHub sync is off by default and makes zero gh calls', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-sync-')); const store = createStore(root); store.ensure();
  let calls = 0; const clock = fakeClock();
  const server = createServeServer({ store, clock, ghRun: () => { calls += 1; return { stdout: '[]', status: 0 }; } });
  try { await clock.advance(60 * 60 * 1000); assert.equal(calls, 0); } finally { server.close(); }
});

test('scheduled sync waits for its first tick and reports success, failure, and staleness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-sync-')); const store = createStore(root); store.ensure(); configureGithub(store);
  const clock = fakeClock(); let calls = 0; const server = createServeServer({ store, clock, syncFn: async () => { calls += 1; } });
  try {
    assert.equal(calls, 0); await clock.advance(59 * 1000); assert.equal(calls, 0);
    await clock.advance(1 * 1000); assert.equal(calls, 1);
    const address = await listen(server, { port: 0 }); const state = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
    assert.equal(state.sync.status, 'success');
    clock.jump(60 * 1000);
    const stale = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json(); assert.equal(stale.sync.status, 'stale');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('a failed scheduled sync leaves serve alive and retries with backoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-sync-')); const store = createStore(root); store.ensure(); configureGithub(store);
  const clock = fakeClock(); let calls = 0; const server = createServeServer({ store, clock, syncFn: async () => { calls += 1; throw new Error('offline'); } });
  try {
    const address = await listen(server, { port: 0 }); await clock.advance(60 * 1000); assert.equal(calls, 1);
    const state = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json(); assert.equal(state.sync.status, 'failure'); assert.match(state.sync.lastError, /offline/);
    await clock.advance(119 * 1000); assert.equal(calls, 1); await clock.advance(1 * 1000); assert.equal(calls, 2);
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/state`)).status, 200);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
