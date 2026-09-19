import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { readConfig } from '../lib/config.js';
import { createServeServer, listen } from '../lib/serve/server.js';
import { describeStage } from '../lib/gates/describe.js';

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

function configureRunner(store, over = {}) {
  const config = readConfig(store);
  config.runner = { ...config.runner, ...over };
  writeFileSync(store.paths.config, JSON.stringify(config));
}

// Fabricates a run record the way lib/run/registry.js would have -- never by
// spawning anything. Tests must not spawn real agents.
function writeRun(store, record) {
  const dir = join(store.dir, 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${record.run}.json`), JSON.stringify(record));
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

// P0-15 removed the item field `gate`, with no migration path (`gw upgrade`
// promises data files stay byte-identical). The default `item` fixture above
// already carries a legacy `gate: 'G0'` key for exactly this reason: the
// serve state payload must round-trip it like any other unrecognized item
// property, never choke on it or strip it silently.
test('the state payload tolerates a legacy gate key on disk without crashing', async () => {
  await withServer(async ({ url }) => {
    const response = await fetch(url + '/api/state');
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.items[0].gate, 'G0', 'a legacy field round-trips through state exactly like any other item property');
  });
});

test('state transitions reject a skipped earlier gate even when the immediate target passes', async () => {
  const stages = {
    stages: [
      { id: 'backlog' }, { id: 'building', requires: { owner: true } },
      { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: {} },
    ],
    terminal: [], extra: [],
  };
  // The target's own gate is empty, so it passes; the refusal must come from
  // the skipped building owner gate alone. The recorded `commit` entry counts
  // only for the built gate it was supplied for (T-0029) — a lifetime reading
  // would not change this verdict, but it is what keeps the built gate green.
  const progressed = {
    ...item, stage: 'built', owner: null,
    evidence: [{ text: 'commit', stage: 'built' }],
  };
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

// viewer/board.html cannot import lib/gates/describe.js, so the descriptions
// ride along with the stages payload it already reads. Asserting against
// describeStage itself is the point: if the two ever disagree, the board is
// describing a rule nobody enforces.
test('state carries every stage gate in the English lib/gates/describe.js produces', async () => {
  const stages = {
    stages: [
      { id: 'backlog', label: 'Backlog' },
      { id: 'building', label: 'Building', requires: { owner: true } },
      { id: 'built', label: 'Built', requires: { evidence_min: 1, deps_at_least: 'building' } },
    ],
    terminal: [], extra: [{ id: 'paused', label: 'Paused' }],
  };
  await withServer(async ({ url }) => {
    const state = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(Object.keys(state.stages.gates), ['backlog', 'building', 'built', 'paused']);
    assert.deepEqual(state.stages.gates.built, describeStage(stages.stages[2], stages));
    assert.deepEqual(state.stages.gates.built.sentences, [
      'Needs at least one new piece of evidence, distinct from anything already recorded',
      'Every dependency must have reached Building',
    ]);
    assert.deepEqual(state.stages.gates.backlog.sentences, ['Nothing is checked here: this stage is advanced by hand']);
    // The raw rules are still there; the sentences are an addition, not a
    // replacement, because agents read this payload too.
    assert.deepEqual(state.stages.stages[2].requires, { evidence_min: 1, deps_at_least: 'building' });
  }, { stages });
});

test('a blocked transition names only the conditions it actually failed, in English', async () => {
  const stages = {
    stages: [
      { id: 'backlog' },
      { id: 'building', requires: { owner: true } },
      { id: 'built', requires: { evidence_min: 2, deps_at_least: 'building' } },
    ],
    terminal: [], extra: [],
  };
  // Owned and with no dependencies, so the owner and deps_at_least rules pass;
  // only the evidence minimum is unmet.
  const owned = { ...item, stage: 'building', owner: 'human:rahil', deps: [], evidence: ['abc1234'] };
  await withServer(async ({ url }) => {
    const result = await (await transitions(url)).json();
    assert.equal(result.built.ok, false);
    assert.deepEqual(result.built.reasons, ['Needs at least two new pieces of evidence, distinct from anything already recorded']);
    // The CLI wording survives untouched beside it: it carries the command.
    assert.match(result.built.failures.join(' '), /gw move P1-01 built --evidence/);
    // A transition that passes says nothing, rather than listing rules it met.
    assert.equal(result.backlog.ok, true);
    assert.equal('reasons' in result.backlog, false);
  }, { items: [owned], stages });
});

test('a blocked transition explains an earlier gate it never reached', async () => {
  const stages = {
    stages: [
      { id: 'backlog' },
      { id: 'building', requires: { owner: true } },
      { id: 'built', requires: { evidence_min: 1 } },
    ],
    terminal: [], extra: [],
  };
  const unowned = { ...item, stage: 'building', owner: null, evidence: [] };
  await withServer(async ({ url }) => {
    const result = await (await transitions(url)).json();
    assert.deepEqual(result.built.reasons, [
      'Someone must have claimed it',
      'Needs at least one new piece of evidence, distinct from anything already recorded',
    ], 'the cumulative gate explains the skipped stage as well as the target');
  }, { items: [unowned], stages });
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

test('state reports active runs from the registry and an honest scheduler status', async () => {
  await withServer(async ({ store, url }) => {
    const off = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(off.runs, []);
    assert.equal(off.scheduler.status, 'disabled');

    configureRunner(store, { enabled: true, paused: true });
    const paused = await (await fetch(url + '/api/state')).json();
    assert.equal(paused.scheduler.status, 'paused');

    configureRunner(store, { enabled: true, paused: false });
    writeRun(store, { run: 'r-1', item: 'P1-01', pid: 999999, provider: 'claude', worktree: '/tmp/wt', started: '2026-01-03T00:00:00Z', log: null });
    const running = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(running.runs, [{ item: 'P1-01', run: 'r-1', provider: 'claude', started: '2026-01-03T00:00:00Z' }]);
    assert.equal(running.scheduler.status, 'at_capacity', 'default max_concurrent is 1 and a run is recorded');
  });
});

test('unconfigured runner is reported distinctly from a disabled one', async () => {
  await withServer(async ({ store, url }) => {
    configureRunner(store, { enabled: true, provider: 'nope' });
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.scheduler.status, 'unconfigured');
  });
});

test('GET /api/runs/:run/log tails the recorded log file and never builds a path from the run id', async () => {
  await withServer(async ({ store, url }) => {
    const dir = join(store.dir, 'runs'); mkdirSync(dir, { recursive: true });
    const logPath = join(dir, 'r-1.log');
    writeFileSync(logPath, Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n') + '\n');
    writeRun(store, { run: 'r-1', item: 'P1-01', pid: 999999, provider: 'claude', worktree: '/tmp/wt', started: '2026-01-03T00:00:00Z', log: logPath });

    const full = await (await fetch(url + '/api/runs/r-1/log?tail=200')).json();
    assert.equal(full.item, 'P1-01');
    assert.equal(full.log, 'line 0\nline 1\nline 2\nline 3\nline 4');

    const tailed = await (await fetch(url + '/api/runs/r-1/log?tail=2')).json();
    assert.equal(tailed.log, 'line 3\nline 4');

    for (const evil of ['../../etc/passwd', '..%2f..%2fetc%2fpasswd', String(logPath)]) {
      const res = await fetch(url + '/api/runs/' + encodeURIComponent(evil) + '/log');
      assert.equal(res.status, 404, `expected 404 for run id ${evil}`);
    }

    assert.equal((await fetch(url + '/api/runs/no-such-run/log')).status, 404);
  });
});

test('GET /api/runs/:run/log tolerates a run with no log yet', async () => {
  await withServer(async ({ store, url }) => {
    writeRun(store, { run: 'r-2', item: 'P1-01', pid: 999999, provider: 'claude', worktree: '/tmp/wt', started: '2026-01-03T00:00:00Z', log: null });
    const body = await (await fetch(url + '/api/runs/r-2/log')).json();
    assert.equal(body.log, '');
  });
});

test('POST /api/items/:id/triage approves or drops a held item through lib/commands/triage.js', async () => {
  const held = { ...item, flag: 'needs-triage', created_by: 'agent' };
  await withServer(async ({ store, url }) => {
    const bad = await write(url, '/api/items/P1-01/triage', { action: 'sideways' });
    assert.equal(bad.status, 400);

    const res = await write(url, '/api/items/P1-01/triage', { action: 'approve' });
    assert.equal(res.status, 200);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.items[0].flag, null);
  }, { items: [held] });

  await withServer(async ({ url }) => {
    const notHeld = await write(url, '/api/items/P1-01/triage', { action: 'drop' });
    assert.equal(notHeld.status, 409);
  });
});

test('POST /api/items/:id/resume clears a paused item and dispatches it again', async () => {
  const paused = { ...item, flag: 'paused', prev_stage: 'building' };
  await withServer(async ({ url }) => {
    const res = await write(url, '/api/items/P1-01/resume', {});
    assert.equal(res.status, 200);
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.items[0].flag, null);
    assert.equal(state.items[0].stage, 'building');
    assert.ok(state.events.some((e) => e.type === 'dispatch' && e.item === 'P1-01'));
  }, { items: [paused] });

  await withServer(async ({ url }) => {
    const res = await write(url, '/api/items/missing/resume', {});
    assert.equal(res.status, 400);
  });
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

// The board's API has no authentication and can start an agent run, so which
// interface it binds is a security property, not a convenience. The default
// must stay loopback no matter what else changes around it.
test('listen binds loopback by default and only leaves it when asked', async () => {
  const server = createServeServer({ store: createStore(mkdtempSync(join(tmpdir(), 'gw-serve-bind-'))) });
  try {
    const address = await listen(server, { port: 0 });
    assert.equal(address.address, '127.0.0.1', 'default bind must not be reachable off this machine');
    // Proves the assertion above is about the default rather than the only
    // thing listen can do: an explicit host is still honoured.
    await new Promise((resolve) => server.close(resolve));
    const second = createServeServer({ store: createStore(mkdtempSync(join(tmpdir(), 'gw-serve-bind2-'))) });
    const wide = await listen(second, { port: 0, host: '0.0.0.0' });
    assert.equal(wide.address, '0.0.0.0');
    await new Promise((resolve) => second.close(resolve));
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

// --host widens the Host/Origin allow-list by this machine's own addresses.
// It must not become "any host": that allow-list is the CSRF boundary that
// stops another site driving the board through a visitor's browser.
//
// Uses http.request, not fetch: Host is a forbidden header name in fetch, so
// undici silently drops it and every request goes out as 127.0.0.1 -- which
// made the first version of this test pass for the wrong reason in both
// directions.
function rawRequest(port, { host, origin, method = 'GET', path = '/api/state', body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host };
    if (origin) headers.origin = origin;
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
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

test('an allowed host is served while a foreign host and a foreign origin are still refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-host-'));
  const store = createStore(root); store.ensure(); store.writeItems([item]);
  const server = createServeServer({ store, allowedHosts: ['192.168.1.37'] });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  const port = address.port;
  try {
    const allowed = await rawRequest(port, { host: `192.168.1.37:${port}` });
    assert.equal(allowed.status, 200, 'the address --host named is answered');

    const foreign = await rawRequest(port, { host: `10.9.9.9:${port}` });
    assert.equal(foreign.status, 403, 'an address this server was not bound for is still refused');

    // The dangerous shape: a browser on the LAN, driven by a page that is not
    // the board, carrying a legitimate Host but an attacker's Origin.
    const crossOrigin = await rawRequest(port, {
      host: `192.168.1.37:${port}`, origin: 'http://evil.example',
      method: 'POST', path: '/api/items', body: JSON.stringify({ title: 'forged' }),
    });
    assert.equal(crossOrigin.status, 403, 'a foreign Origin cannot write even from an allowed Host');
    assert.equal(store.readItems().length, 1, 'and nothing was created');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

// A config saying github.enabled: true while the board reports sync "off" is
// how an issue sits unsynced for days with nothing on screen to explain it.
// The two states are different facts and must not report the same way.
test('a repo with sync enabled but no interval reports unscheduled, not off', async () => {
  const withInterval = { github: { enabled: true, repo: 'o/r', sync_interval_min: 5 } };
  const withoutInterval = { github: { enabled: true, repo: 'o/r' } };
  const disabled = { github: { enabled: false, repo: 'o/r', sync_interval_min: 5 } };

  for (const [config, expected, note] of [
    [withInterval, 'idle', 'scheduled'],
    [withoutInterval, 'unscheduled', 'enabled but never scheduled'],
    [disabled, 'off', 'genuinely off'],
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'gw-syncstate-'));
    const store = createStore(root); store.ensure(); store.writeItems([]);
    writeFileSync(store.paths.config, JSON.stringify(config));
    const server = createServeServer({ store });
    const address = await listen(server, { port: 0 });
    const state = await (await fetch(`http://127.0.0.1:${address.port}/api/state`)).json();
    assert.equal(state.sync.status, expected, `${note} must report "${expected}"`);
    await new Promise((resolve) => server.close(resolve));
  }
});

// Enabling sync has to mean it syncs.
test('init --gh schedules the sync it enables', async () => {
  const { run: init } = await import('../lib/commands/init.js');
  const cwd = mkdtempSync(join(tmpdir(), 'gw-ghinit-'));
  let out = '';
  await init({
    cwd, flags: { gh: true, repo: 'o/r', yes: true }, positionals: [], env: {},
    stdout: { write: (t) => { out += t; } }, stderr: { write() {} },
    // The gh boundary returns a result object, not a string: authStatus checks
    // `status`, which is what makes the whole sync layer testable without a
    // network or a logged-in gh.
    ghRun: () => ({ status: 0, stdout: '' }),
  });
  const config = JSON.parse(readFileSync(join(cwd, '.gatewright', 'config.json'), 'utf8'));
  assert.equal(config.github.enabled, true);
  assert.ok(config.github.sync_interval_min > 0, 'enabling sync without an interval leaves a board that never syncs');
  assert.match(out, /polling every \d+ min/, 'and the user is told the cadence rather than having to discover it');
});
