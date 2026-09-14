import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';

const item = { id: 'P1-01', title: 'Live board', phase: 'P1', priority: 'P1', gate: 'G0', type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '', deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };

async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-'));
  const store = createStore(root); store.ensure(); store.writeItems([item]);
  store.appendEvent({ ts: '2026-01-01T00:00:00.000Z', type: 'add', item: item.id, by: 'human' });
  store.appendEvent({ ts: '2026-01-02T00:00:00.000Z', type: 'move', item: item.id, by: 'human', from: 'backlog', to: 'specified' });
  const server = createServeServer({ store }); const address = await listen(server, { port: 0 });
  try { await fn({ store, url: `http://127.0.0.1:${address.port}` }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('serve returns state, filters events, serves an empty-shell viewer, and refuses unknown paths', async () => {
  await withServer(async ({ url }) => {
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.items[0].id, 'P1-01'); assert.equal(state.events.length, 2); assert.ok(state.generatedAt);
    const since = await (await fetch(url + '/api/state?since=2026-01-01T12:00:00.000Z')).json();
    assert.equal(since.events.length, 1); assert.equal(since.events[0].type, 'move');
    const shell = await (await fetch(url + '/')).text();
    assert.match(shell, /fetch\('\/api\/state'\)/); assert.doesNotMatch(shell, /id="gw-items"/);
    assert.equal((await fetch(url + '/../../etc/passwd')).status, 404);
    assert.equal((await fetch(url + '/nope')).status, 404);
  });
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
