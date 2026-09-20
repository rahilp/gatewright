import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';

// T-0130 -- THE HOST HEADER IS NOT A URL.
//
// A browser sends `Host: localhost:7911`, a bare authority. An Origin is a
// whole URL, `http://localhost:7911`. Parsing the first with `new URL()` does
// not throw -- "localhost:" is a valid scheme -- it returns an empty hostname,
// so the board answered 403 on the very address it printed, and `--host <name>`
// could not be opened in a browser at all. Only bare IP literals worked, and
// only because those DO throw and fell through to a split fallback.
//
// This file is the whole matrix: every shape a real browser sends has to be
// answered, and the CSRF boundary has to stay exactly as strict as it was --
// a missing or foreign Origin still refuses a write, and /api/stages and
// /api/config stay loopback-only however the server was bound.

const item = { id: 'P1-01', title: 'Live board', phase: 'P1', priority: 'P1', gate: 'G0', type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '', deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };

async function withBoard(fn, { allowedHosts = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-host-'));
  const store = createStore(root); store.ensure(); store.writeItems([item]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'], gate: ['G0'] }, runner: { paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'built', requires: { evidence_min: 1 } }], terminal: ['built'], extra: [] }));
  store.rebaselineDigest();
  const server = createServeServer({ store, allowedHosts });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  try { await fn({ store, port: address.port }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

// node:http, never fetch: Host is a forbidden header name in fetch, so undici
// drops it and the request goes out as 127.0.0.1 -- which is how a Host test
// passes against code that never reads Host at all.
function raw(port, { host, origin, method = 'GET', path = '/api/state', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (host !== undefined) headers.host = host;
    if (origin) headers.origin = origin;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('every address the board can be opened on answers a read: localhost, an IP literal, IPv6 loopback, and a --host name', async () => {
  await withBoard(async ({ port }) => {
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `mybox:${port}`, 'mybox', 'LOCALHOST']) {
      const response = await raw(port, { host });
      assert.equal(response.status, 200, `Host: ${host} must be answered -- it is an address this board was told to serve`);
    }
  }, { allowedHosts: ['mybox'] });
});

test('a host the board was never bound for is still refused, whatever shape it arrives in', async () => {
  await withBoard(async ({ port }) => {
    for (const host of [`evil.example:${port}`, 'evil.example', `10.9.9.9:${port}`, `[fd00::99]:${port}`, 'localhost.evil.example']) {
      const response = await raw(port, { host });
      assert.equal(response.status, 403, `Host: ${JSON.stringify(host)} is not this board and must be refused`);
    }
  }, { allowedHosts: ['mybox'] });
});

// The fix widens which Host values PARSE. It must not widen which ones pass.
// A Host header carrying a path, a query, a fragment or userinfo is malformed,
// and guessing at what it meant is exactly how an allow-list gets talked
// around -- `attacker@localhost` must never read as `localhost`.
test('a malformed Host is refused rather than reinterpreted into an allowed one', async () => {
  await withBoard(async ({ port }) => {
    for (const host of [`attacker@localhost:${port}`, `evil.example/localhost:${port}`, `localhost:${port}/../evil`, `localhost:${port}?x=1`, `localhost:${port}#f`, `evil.example\\localhost`]) {
      const response = await raw(port, { host });
      assert.equal(response.status, 403, `Host: ${host} is malformed and must not be read as an allowed host`);
    }
  }, { allowedHosts: ['mybox'] });
});

test('a read carrying a foreign Origin is refused even from an allowed Host', async () => {
  await withBoard(async ({ port }) => {
    assert.equal((await raw(port, { host: `localhost:${port}`, origin: 'http://evil.example' })).status, 403);
    assert.equal((await raw(port, { host: `localhost:${port}`, origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await raw(port, { host: `mybox:${port}`, origin: `http://mybox:${port}` })).status, 200);
  }, { allowedHosts: ['mybox'] });
});

test('a write succeeds from each allowed address with its own Origin', async () => {
  await withBoard(async ({ store, port }) => {
    const pairs = [
      [`localhost:${port}`, `http://localhost:${port}`],
      [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
      [`[::1]:${port}`, `http://[::1]:${port}`],
      [`mybox:${port}`, `http://mybox:${port}`],
    ];
    for (const [host, origin] of pairs) {
      const response = await raw(port, { host, origin, method: 'POST', path: '/api/items/P1-01/note', body: JSON.stringify({ text: `from ${host}` }) });
      assert.equal(response.status, 200, `a write from ${host} with its own Origin is the feature`);
    }
    assert.equal(store.readEvents().filter((event) => event.type === 'note').length, pairs.length, 'each accepted write appended exactly one event');
  }, { allowedHosts: ['mybox'] });
});

// THE CSRF BOUNDARY, UNCHANGED. Widening which Host values parse must not
// relax any of this: a write still requires an Origin, that Origin still has
// to be one of this server's own addresses, and it still has to be JSON.
test('a write with a missing, foreign or unparseable Origin is still forbidden', async () => {
  await withBoard(async ({ store, port }) => {
    const refused = [
      { host: `localhost:${port}`, origin: undefined },
      { host: `localhost:${port}`, origin: 'http://evil.example' },
      { host: `localhost:${port}`, origin: 'null' },
      { host: `localhost:${port}`, origin: `localhost:${port}` },
      { host: `mybox:${port}`, origin: `http://evil.example:${port}` },
      { host: `evil.example:${port}`, origin: `http://evil.example:${port}` },
    ];
    for (const { host, origin } of refused) {
      const response = await raw(port, { host, origin, method: 'POST', path: '/api/items/P1-01/note', body: JSON.stringify({ text: 'forged' }) });
      assert.equal(response.status, 403, `Host ${host} with Origin ${String(origin)} must not be able to write`);
    }
    assert.deepEqual(store.readEvents(), [], 'not one forbidden write appended an event');
  }, { allowedHosts: ['mybox'] });
});

// Item writes travel as far as the board does; rule changes do not. `--host`
// widens `allowed`, and adminAllowed deliberately compares against LOOPBACK
// instead, so no --host argument can ever widen it. Making `localhost:<port>`
// parse has to fix the loopback side of that split without opening the remote
// side.
test('stages and settings are writable from every loopback form and from no other host', async () => {
  await withBoard(async ({ store, port }) => {
    for (const [host, origin] of [[`localhost:${port}`, `http://localhost:${port}`], [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`], [`[::1]:${port}`, `http://[::1]:${port}`]]) {
      const response = await raw(port, { host, origin, method: 'POST', path: '/api/config', body: JSON.stringify({ key: 'runner.paused', value: true }) });
      assert.equal(response.status, 200, `an administrator at the machine's own ${host} must be able to change a setting`);
      await raw(port, { host, origin, method: 'POST', path: '/api/config', body: JSON.stringify({ key: 'runner.paused', value: false }) });
    }

    const stagesBefore = store.readStages?.() ?? null;
    const remote = await raw(port, { host: `mybox:${port}`, origin: `http://mybox:${port}`, method: 'POST', path: '/api/config', body: JSON.stringify({ key: 'runner.enabled', value: true }) });
    assert.equal(remote.status, 403, 'a remote caller must not be able to start the runner');
    assert.match(remote.text, /loopback only/, 'and must be told which boundary refused it');

    const stages = await raw(port, { host: `mybox:${port}`, origin: `http://mybox:${port}`, method: 'PUT', path: '/api/stages', body: JSON.stringify({ stages: [{ id: 'backlog' }], terminal: ['backlog'], extra: [] }) });
    assert.equal(stages.status, 403, 'a remote caller must not be able to rewrite the pipeline');
    if (stagesBefore) assert.deepEqual(store.readStages(), stagesBefore, 'the refused stage write touched nothing');
  }, { allowedHosts: ['mybox'] });
});

// /api/state tells the board which controls to draw. It has to agree with the
// guard above, or the board offers a button that answers 403.
test('/api/state reports admin allowed for localhost and refused for a --host name', async () => {
  await withBoard(async ({ port }) => {
    const local = await raw(port, { host: `localhost:${port}` });
    assert.deepEqual(JSON.parse(local.text).admin, { allowed: true }, 'a browser opened on localhost is at the machine running gw serve');
    const remote = await raw(port, { host: `mybox:${port}` });
    assert.deepEqual(JSON.parse(remote.text).admin, { allowed: false }, 'a colleague on the LAN must not be offered the rule controls');
  }, { allowedHosts: ['mybox'] });
});
