import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';
import { runRouter } from '../lib/cli/router.js';

const item = { id: 'P1-01', title: 'Existing item', phase: 'P1', priority: 'P1', gate: 'G0', type: 'feature', stage: 'specified', flag: null, owner: 'human:tester', scope: '', deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };

async function withServer(fn, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-write-'));
  const store = createStore(root); store.ensure(); store.writeItems([item]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'], gate: ['G0'] }, runner: { paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building' }, { id: 'built', requires: { evidence_min: 1 } }], terminal: [], extra: [] }));
  // The fixture writes config.json and stages.json by hand to stand up the board; baseline the digest so only deliberate tampering in a test is ever reported.
  store.rebaselineDigest();
  const server = createServeServer({ store, ...options }); const address = await listen(server, { port: 0 });
  try { await fn({ root, store, url: `http://127.0.0.1:${address.port}` }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function write(url, path, body, headers = {}, method = 'POST') {
  return fetch(url + path, { method, headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function rawWrite(url, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(body);
  });
}

// fetch() silently drops a Host header -- it is a forbidden header name -- so
// anything asserting Host behaviour has to go through node:http directly, or it
// passes against code that never checks Host at all.
function raw(url, path, { method = 'POST', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('write endpoints use command behaviour and append one event each', async () => {
  await withServer(async ({ store, url }) => {
    assert.equal((await write(url, '/api/items', { title: 'New item', phase: 'P1' })).status, 200);
    const added = store.readItems().find((candidate) => candidate.title === 'New item');
    assert.ok(added);
    assert.equal((await write(url, `/api/items/${added.id}`, { scope: 'finished when tested' })).status, 200);
    assert.equal((await write(url, '/api/items/P1-01/move', { to: 'building', evidence: [] })).status, 200);
    assert.equal((await write(url, '/api/items/P1-01/note', { text: 'A note' })).status, 200);
    assert.equal((await write(url, '/api/items/P1-01/dispatch', { actor: 'sam' })).status, 200);
    assert.equal((await write(url, '/api/items/P1-01/cancel', {})).status, 200);
    const events = store.readEvents();
    assert.deepEqual(events.map((event) => event.type), ['add', 'edit', 'move', 'note', 'dispatch', 'cancel']);
    assert.equal(events.filter((event) => event.type === 'dispatch')[0].by, 'human:sam');
    let stdout = ''; let stderr = '';
    assert.equal(await runRouter(['check'], { cwd: store.root, env: {}, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } }), 0);
    assert.match(stdout, /Board is clean/); assert.equal(stderr, ''); assert.equal(store.verifyDigest().status, 'clean');
  });
});

test('a refused move returns precisely the CLI RuleError failures', async () => {
  await withServer(async ({ root, url }) => {
    const response = await write(url, '/api/items/P1-01/move', { to: 'built', evidence: [] });
    assert.equal(response.status, 409); const body = await response.json();
    let stderr = ''; await runRouter(['move', 'P1-01', 'built'], { cwd: root, env: {}, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
    const failures = stderr.trim().split('\n').slice(1);
    assert.deepEqual(body.failures, failures);
  });
});

test('POST with cross-origin Origin is forbidden', async () => {
  await withServer(async ({ url }) => assert.equal((await write(url, '/api/items/P1-01/note', { text: 'x' }, { Origin: 'https://example.com' })).status, 403));
});
test('POST with no Origin is forbidden', async () => {
  await withServer(async ({ url }) => assert.equal((await fetch(url + '/api/items/P1-01/note', { method: 'POST', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' }, body: '{"text":"x"}' })).status, 403));
});
test('POST with form Content-Type is forbidden', async () => {
  await withServer(async ({ url }) => assert.equal((await write(url, '/api/items/P1-01/note', { text: 'x' }, { 'Content-Type': 'text/plain' })).status, 403));
});
test('POST with non-loopback Host is forbidden', async () => {
  await withServer(async ({ url }) => assert.equal(await rawWrite(url, '/api/items/P1-01/note', '{"text":"x"}', { Host: 'example.com', Origin: url, 'Content-Type': 'application/json' }), 403));
});

test('GET remains available without Origin', async () => {
  await withServer(async ({ url }) => assert.equal((await fetch(url + '/api/state')).status, 200));
});

test('malformed and oversized JSON bodies are rejected safely', async () => {
  await withServer(async ({ url }) => {
    assert.equal((await fetch(url + '/api/items/P1-01/note', { method: 'POST', headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.ok([400, 413].includes((await fetch(url + '/api/items/P1-01/note', { method: 'POST', headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }) })).status));
  });
});

test('pause and resume persist runner.paused and log one event each', async () => {
  await withServer(async ({ store, url }) => {
    assert.equal((await write(url, '/api/pause', {})).status, 200);
    assert.equal(JSON.parse(readFileSync(store.paths.config, 'utf8')).runner.paused, true);
    assert.equal((await write(url, '/api/resume', {})).status, 200);
    assert.equal(JSON.parse(readFileSync(store.paths.config, 'utf8')).runner.paused, false);
    assert.deepEqual(store.readEvents().map((event) => event.type), ['pause_all', 'resume_all']);
  });
});

// Every board write that rewrites the rules — pause, resume, settings, the
// pipeline — is a write gw performed, so it must re-baseline the digest and
// leave `gw check` clean. A tamper report on gw's own writes would bury the
// real one.
test('pause, resume, config and stages writes from the board all keep gw check clean', async () => {
  await withServer(async ({ store, url }) => {
    assert.equal((await write(url, '/api/pause', {})).status, 200);
    assert.equal((await write(url, '/api/resume', {})).status, 200);
    assert.equal((await write(url, '/api/config', { key: 'runner.max_concurrent', value: 3 })).status, 200);
    assert.equal((await write(url, '/api/stages', NEXT_STAGES, {}, 'PUT')).status, 200);
    // A note records activity, so the fixture item's old timestamp cannot
    // surface as an unrelated stale-owner finding in the check below.
    assert.equal((await write(url, '/api/items/P1-01/note', { text: 'activity' })).status, 200);
    let stdout = ''; let stderr = '';
    assert.equal(await runRouter(['check'], { cwd: store.root, env: {}, stdout: { write: (text) => { stdout += text; } }, stderr: { write: (text) => { stderr += text; } } }), 0);
    assert.equal(stdout, 'Board is clean.\n');
    assert.equal(store.verifyDigest().status, 'clean');
  });
});

// The README has always advertised per-run stop as one of three kill
// switches, but the board could only cancel a dispatch that had not started.
// An item whose agent was actually running could not be stopped from the very
// screen showing it running.
test('a live run can be stopped from the board, and stopping nothing is not an error', async () => {
  await withServer(async ({ url, store }) => {
    const idle = await write(url, '/api/items/P1-01/stop', {});
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { ok: true, stopped: 0 }, 'a card with no live run must not error');

    // A real child this test owns, so the kill path is exercised without ever
    // signalling a pid belonging to something else.
    // stop_timeout_s is the grace period between the polite stop and the
    // forceful one, and lifecycle waits it out synchronously. Left at the
    // default 30s this test would sit there for half a minute -- which is
    // itself worth knowing, because that wait happens inside the request
    // handler and blocks the whole single-threaded server.
    writeFileSync(store.paths.config, JSON.stringify({ version: 1, runner: { paused: false, stop_timeout_s: 1 } }));
    const { spawn } = await import('node:child_process');
    // cwd MUST match the worktree recorded below: the pid-reuse guard compares
    // /proc/<pid>/cwd against the record and refuses to kill a process it
    // cannot prove is the one it started. A mismatch leaves the child alive,
    // which also keeps this test process alive forever.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', cwd: store.root });
    const { createRunRegistry } = await import('../lib/run/registry.js');
    const registry = createRunRegistry({ store });
    registry.record({ run: 'r-1', item: 'P1-01', pid: child.pid, provider: 'stub', worktree: store.root, log: null, started: new Date().toISOString() });

    const response = await write(url, '/api/items/P1-01/stop', {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).stopped, 1);

    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 5000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    assert.notEqual(child.exitCode === null && child.signalCode === null, true, 'the process is actually gone, not just recorded as stopped');
    assert.ok(store.readEvents().some((event) => event.type === 'run_ended' && event.item === 'P1-01'), 'the ending is durable');
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone, which is the point */ }
  });
});

test('POST /api/items/<id>/edit changes title and scope through the CLI command', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/items/P1-01/edit', { title: 'Renamed from the board', scope: 'finished when the board can edit' });
    assert.equal(response.status, 200, 'an item-level edit is allowed wherever the board is reachable');
    const edited = store.readItems().find((candidate) => candidate.id === 'P1-01');
    assert.equal(edited.title, 'Renamed from the board', 'the edited title must be visible in the stored item');
    assert.equal(edited.scope, 'finished when the board can edit', 'the edited scope must be visible in the stored item');
    const events = store.readEvents();
    assert.deepEqual(events.map((event) => event.type), ['edit'], 'edit goes through the CLI command, which appends exactly one edit event');
    assert.deepEqual(events[0].fields, ['title', 'scope'], 'the event records the same changed fields the CLI would record');
  });
});

test('deps sent as a JSON array are stored as a dependency list', async () => {
  await withServer(async ({ store, url }) => {
    assert.equal((await write(url, '/api/items', { title: 'Dependency', phase: 'P1' })).status, 200);
    const other = store.readItems().find((candidate) => candidate.title === 'Dependency');
    const response = await write(url, '/api/items/P1-01/edit', { deps: [other.id] });
    assert.equal(response.status, 200, 'an array deps value must be accepted, not rejected as a non-string flag');
    const edited = store.readItems().find((candidate) => candidate.id === 'P1-01');
    assert.deepEqual(edited.deps, [other.id], 'an array body value must reach the store as the same list the CLI comma-string produces');
  });
});

test('an out-of-vocab priority is refused by the CLI validation and writes nothing', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.items);
    const response = await write(url, '/api/items/P1-01/edit', { title: 'Would have changed', priority: 'P9' });
    assert.equal(response.status, 400, 'serve must refuse exactly what the CLI refuses, not apply its own validation');
    const body = await response.json();
    assert.match(body.error, /invalid --priority 'P9'/, 'the refusal must carry the CLI vocab message');
    assert.deepEqual(readFileSync(store.paths.items), before, 'a refused edit must leave items.jsonl byte-identical: nothing partial is written');
    assert.deepEqual(store.readEvents(), [], 'a refused edit must not append an event');
  });
});

test('POST to /edit with a non-loopback Host is still forbidden', async () => {
  await withServer(async ({ store, url }) => {
    const status = await rawWrite(url, '/api/items/P1-01/edit', JSON.stringify({ title: 'Cross-host' }), { Host: 'example.com', Origin: url, 'Content-Type': 'application/json' });
    assert.equal(status, 403, 'the edit route must sit behind the same Host/Origin guard as every other write');
    assert.equal(store.readItems().find((candidate) => candidate.id === 'P1-01').title, 'Existing item', 'a forbidden request must not reach the command');
  });
});


// ---------------------------------------------------------------------------
// Stage and settings writes.
//
// These change the RULES of the board rather than the work on it, so they are
// loopback-only however the server was bound. The tests below prove both
// halves of that split: an admin write is refused from an allowed non-loopback
// host, and an item write from that very same host still works.
// ---------------------------------------------------------------------------

const NEXT_STAGES = {
  stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building' }, { id: 'review', requires: { owner: true } }, { id: 'built', requires: { evidence_min: 1 } }],
  terminal: ['built'],
  extra: [{ id: 'paused', role: 'paused' }],
};

test('PUT /api/stages replaces the pipeline and the new stages read back', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/stages', NEXT_STAGES, {}, 'PUT');
    assert.equal(response.status, 200, 'a valid pipeline must be accepted');
    const saved = JSON.parse(readFileSync(store.paths.stages, 'utf8'));
    assert.deepEqual(saved.stages.map((stage) => stage.id), ['backlog', 'specified', 'building', 'review', 'built']);
    assert.deepEqual(saved.terminal, ['built']);
    assert.deepEqual(saved.extra.map((stage) => stage.id), ['paused']);
    const state = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(state.stages.stages.map((stage) => stage.id), ['backlog', 'specified', 'building', 'review', 'built'], 'the board must serve the pipeline that was just written');
    assert.ok(state.stages.gates.review, 'the new stage gets its gate description like any other');
    assert.deepEqual(store.readEvents().map((event) => event.type), ['stages'], 'a pipeline change is recorded once');
  });
});

test('POST /api/stages is accepted as well as PUT', async () => {
  await withServer(async ({ url }) => {
    assert.equal((await write(url, '/api/stages', NEXT_STAGES)).status, 200);
  });
});

test('an invalid pipeline is refused with the validator findings and stages.json is untouched', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.stages);
    const response = await write(url, '/api/stages', {
      stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'specified' }, { id: 'building' }, { id: 'built' }],
      terminal: ['shipped'],
      extra: [],
    }, {}, 'PUT');
    assert.equal(response.status, 400, 'an invalid pipeline must be refused, not written and left for gw check to find');
    const body = await response.json();
    assert.ok(body.findings.some((finding) => /duplicate stage id/.test(finding)), 'the duplicate id finding is returned to the caller');
    assert.ok(body.findings.some((finding) => /"shipped" does not name a stage/.test(finding)), 'the dangling terminal finding is returned to the caller');
    assert.deepEqual(readFileSync(store.paths.stages), before, 'a refused pipeline must leave stages.json byte-identical');
    assert.deepEqual(store.readEvents(), [], 'a refused pipeline must not append an event');
  });
});

test('removing a stage that still holds items is refused, naming the stage and the count', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.stages);
    const response = await write(url, '/api/stages', {
      stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', requires: { evidence_min: 1 } }],
      terminal: [], extra: [],
    }, {}, 'PUT');
    assert.equal(response.status, 400, 'items must never be orphaned into a stage that no longer exists');
    const body = await response.json();
    assert.match(body.error, /specified/, 'the refusal names the stage');
    assert.match(body.error, /1 item\b/, 'the refusal carries the count of items still there');
    assert.deepEqual(readFileSync(store.paths.stages), before, 'a refused removal leaves stages.json byte-identical');
  });
});

test('removing a stage named by another stage deps_at_least is refused', async () => {
  await withServer(async ({ store, url }) => {
    // 'backlog' holds no items, so only the dependency reference stands in the
    // way of removing it.
    const response = await write(url, '/api/stages', {
      stages: [{ id: 'specified' }, { id: 'building', requires: { deps_at_least: 'backlog' } }, { id: 'built' }],
      terminal: [], extra: [],
    }, {}, 'PUT');
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /deps_at_least/, 'the refusal says which rule still names the stage');
    assert.match(body.error, /backlog/, 'the refusal names the stage that cannot go');
    assert.deepEqual(store.readEvents(), [], 'nothing is recorded for a refused pipeline');
  });
});

test('POST /api/config sets a setting and persists it', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/config', { key: 'runner.max_concurrent', value: 3 });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).config, { 'runner.max_concurrent': 3 });
    const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
    assert.equal(saved.runner.max_concurrent, 3);
    assert.equal(saved.runner.paused, false, 'the rest of config.json survives the write');
    assert.deepEqual(saved.vocab.phase, ['P1'], 'settings the request did not name are left alone');
    assert.deepEqual(store.readEvents().map((event) => event.type), ['config']);
  });
});

test('POST /api/config sets several settings at once', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/config', { settings: { 'runner.enabled': true, 'vocab.phase': 'P1,P2' } });
    assert.equal(response.status, 200);
    const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
    assert.equal(saved.runner.enabled, true);
    assert.deepEqual(saved.vocab.phase, ['P1', 'P2'], 'a list setting is coerced exactly as gw config coerces it');
  });
});

test('an unknown config key is refused with the CLI message and writes nothing', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.config);
    const response = await write(url, '/api/config', { key: 'runner.turbo', value: true });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /unknown setting: runner\.turbo/, 'the board refuses what the CLI refuses, in the same words');
    assert.deepEqual(readFileSync(store.paths.config), before, 'a refused setting leaves config.json byte-identical');
  });
});

// P8-19 — `gw config glossary.phase.P1 "..."` worked, but the board's Settings
// UI could never reach the same key: /api/config validated only through
// SETTINGS_BY_KEY, which does not (and should not) enumerate a map keyed by
// the user's own vocab. The fix moves the glossary write into
// lib/settings.js (applyGlossaryEntry) so both callers share one validating
// path -- these tests prove the endpoint now accepts what the CLI accepts,
// and refuses what the CLI refuses, in the CLI's exact words.
test('P8-19: POST /api/config sets a glossary entry the CLI accepts, and it round-trips through config.json', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/config', { key: 'glossary.phase.P1', value: 'The first working version.' });
    assert.equal(response.status, 200, 'the board must be able to set a glossary entry, not only the CLI');
    assert.deepEqual((await response.json()).config, { 'glossary.phase.P1': 'The first working version.' });
    const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
    assert.equal(saved.glossary.phase.P1, 'The first working version.');
    assert.deepEqual(store.readEvents().map((event) => event.type), ['config']);
  });
});

test('P8-19: POST /api/config refuses an unknown glossary field with the exact CLI wording, and writes nothing', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.config);
    let stderr = '';
    await runRouter(['config', 'glossary.colour.G0', 'nope'], { cwd: store.root, env: {}, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
    const response = await write(url, '/api/config', { key: 'glossary.colour.G0', value: 'nope' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /glossary\.colour\.G0 names an unknown vocab field: colour/);
    assert.ok(stderr.includes(body.error), 'the endpoint must refuse an unknown glossary field in the same words the CLI uses');
    assert.deepEqual(readFileSync(store.paths.config), before, 'a refused glossary write leaves config.json byte-identical');
  });
});

test('P8-19: an empty glossary value removes the entry through the endpoint, same as the CLI', async () => {
  await withServer(async ({ store, url }) => {
    await write(url, '/api/config', { key: 'glossary.phase.P1', value: 'Something.' });
    const response = await write(url, '/api/config', { key: 'glossary.phase.P1', value: '' });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).config, { 'glossary.phase.P1': null });
    assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')).glossary.phase, {});
  });
});

test('P8-19: glossary and ordinary settings can be set together in one request', async () => {
  await withServer(async ({ store, url }) => {
    const response = await write(url, '/api/config', { settings: { 'glossary.phase.P1': 'The first working version.', 'runner.max_concurrent': 5 } });
    assert.equal(response.status, 200);
    const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
    assert.equal(saved.glossary.phase.P1, 'The first working version.');
    assert.equal(saved.runner.max_concurrent, 5);
  });
});

// P0-15 removed the item field `gate` entirely, so `glossary.gate.*` is now
// refused the same way `glossary.colour.*` always was: an unknown field.
test('P8-19: POST /api/config refuses the removed gate field the same way it refuses any unknown field', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.config);
    const response = await write(url, '/api/config', { key: 'glossary.gate.G0', value: 'nope' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /glossary\.gate\.G0 names an unknown vocab field: gate/);
    assert.deepEqual(readFileSync(store.paths.config), before, 'a refused glossary write leaves config.json byte-identical');
  });
});

test('an out-of-range config value is refused with the CLI message and writes nothing', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.config);
    // The same value through the CLI, so the two messages cannot drift apart.
    let stderr = '';
    await runRouter(['config', 'runner.max_concurrent', '999'], { cwd: store.root, env: {}, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
    const response = await write(url, '/api/config', { key: 'runner.max_concurrent', value: 999 });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /runner\.max_concurrent must be at most 64/);
    assert.ok(stderr.includes(body.error), 'the endpoint gives the same refusal the CLI gives');
    assert.deepEqual(readFileSync(store.paths.config), before, 'a refused setting leaves config.json byte-identical');
  });
});

// T-0050 — the bracketed JSON list form `gw config` accepts (T-0043) used to
// be comma-split by POST /api/config's own copy of the coercion, storing the
// printed form as quoted garbage so `gw add --type doc` was then refused while
// the same help listed `doc` as allowed. The endpoint now goes through the
// same list coercion in lib/settings.js the CLI command uses, so the two
// cannot drift apart again.
test('T-0050: POST /api/config stores the bracketed list form as a real array and the vocabulary works afterwards', async () => {
  await withServer(async ({ store, url }) => {
    const value = JSON.stringify(['decision', 'defect', 'feature', 'test', 'doc', 'spike']);
    const response = await write(url, '/api/config', { key: 'vocab.type', value });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).config, { 'vocab.type': ['decision', 'defect', 'feature', 'test', 'doc', 'spike'] });
    const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
    assert.deepEqual(saved.vocab.type, ['decision', 'defect', 'feature', 'test', 'doc', 'spike'], 'the stored value must be a real array, not a comma-split of the printed form');
    // The saved vocabulary must actually work afterwards, driven through the
    // same command modules the binary runs.
    let stderr = '';
    const code = await runRouter(['add', 'typed work', '--phase', 'P1', '--type', 'doc'], { cwd: store.root, env: {}, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
    assert.equal(code, 0, `gw add --type doc must succeed against the saved vocabulary, got: ${stderr}`);
    assert.equal(store.readItems().find((item) => item.title === 'typed work').type, 'doc');
  });
});

test('T-0050: POST /api/config refuses a malformed bracketed list with the CLI wording and writes nothing', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.config);
    const response = await write(url, '/api/config', { key: 'vocab.type', value: '["a", "b"' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /that bracketed value is not valid JSON/);
    assert.deepEqual(readFileSync(store.paths.config), before, 'a refused value leaves config.json byte-identical');
  });
});

// T-0051 — the serve write path resolved its own actor, so the CLI's bare
// `agent` refusal (a kind with no name) and its bare-name qualification
// (`human:<name>`) did not apply to writes made through the board. It now
// uses the exported actor() from lib/cli/root.js -- the same resolver every
// command passes through -- so there is one actor space, consistent with
// sameOwner().
test('T-0051: a bare agent actor on a board write is refused with the CLI convention named', async () => {
  await withServer(async ({ store, url }) => {
    const before = readFileSync(store.paths.items);
    const response = await write(url, '/api/items', { title: 'Ghost writer', phase: 'P1', by: 'agent' });
    assert.equal(response.status, 400, 'the board must refuse what the CLI refuses, not record it as human:agent');
    const body = await response.json();
    assert.match(body.error, /the actor names no agent: use --by agent:<name>/);
    assert.deepEqual(readFileSync(store.paths.items), before, 'a refused write must not create an item');
    assert.deepEqual(store.readEvents(), [], 'a refused write appends no event');
  });
});

test('T-0051: a bare name actor is recorded as human:<name> and a qualified actor is kept as given', async () => {
  await withServer(async ({ store, url }) => {
    assert.equal((await write(url, '/api/items', { title: 'Named write', phase: 'P1', by: 'rahil' })).status, 200);
    const added = store.readItems().find((item) => item.title === 'Named write');
    assert.equal(added.created_by, 'human:rahil');
    assert.equal(store.readEvents().find((event) => event.type === 'add').by, 'human:rahil');
    assert.equal((await write(url, `/api/items/${added.id}/claim`, { by: 'agent:codex' })).status, 200);
    assert.equal(store.readItems().find((item) => item.id === added.id).owner, 'agent:codex');
  });
});

// THE SECURITY PROPERTY. `gw serve --host 0.0.0.0` exists so a colleague can
// move a card. It must not hand that colleague -- or anyone else who can reach
// the port -- the power to delete stages, disable a gate or start the runner.
test('stage and settings writes are refused from a non-loopback host even when it is allowed', async () => {
  await withServer(async ({ store, url }) => {
    const before = { stages: readFileSync(store.paths.stages), config: readFileSync(store.paths.config) };
    const headers = { Host: 'board.local', Origin: 'http://board.local', 'Content-Type': 'application/json' };

    const stages = await raw(url, '/api/stages', { method: 'PUT', body: JSON.stringify(NEXT_STAGES), headers });
    assert.equal(stages.status, 403, 'a remote caller must not be able to rewrite the pipeline');
    const config = await raw(url, '/api/config', { body: JSON.stringify({ key: 'runner.enabled', value: true }), headers });
    assert.equal(config.status, 403, 'a remote caller must not be able to start the runner');

    assert.deepEqual(readFileSync(store.paths.stages), before.stages, 'the refused stage write touched nothing');
    assert.deepEqual(readFileSync(store.paths.config), before.config, 'the refused settings write touched nothing');
    assert.deepEqual(store.readEvents(), [], 'a refused admin write appends no event');
  }, { allowedHosts: ['board.local'] });
});

test('an item move from that same allowed non-loopback host still succeeds', async () => {
  await withServer(async ({ store, url }) => {
    const headers = { Host: 'board.local', Origin: 'http://board.local', 'Content-Type': 'application/json' };
    const moved = await raw(url, '/api/items/P1-01/move', { body: JSON.stringify({ to: 'building', evidence: [] }), headers });
    assert.equal(moved.status, 200, 'the colleague on the LAN is the feature; only the rules are loopback-only');
    assert.equal(store.readItems().find((candidate) => candidate.id === 'P1-01').stage, 'building');
  }, { allowedHosts: ['board.local'] });
});

test('/api/state reports whether this caller may change stages and settings', async () => {
  await withServer(async ({ url }) => {
    const local = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(local.admin, { allowed: true }, 'a loopback caller may administer the board');
    const remote = await raw(url, '/api/state', { method: 'GET', headers: { Host: 'board.local' } });
    assert.equal(remote.status, 200, 'reading the board from an allowed host still works');
    assert.deepEqual(JSON.parse(remote.text).admin, { allowed: false }, 'the board must be able to hide controls it cannot use rather than offer a button that 403s');
  }, { allowedHosts: ['board.local'] });
});

// The board can offer a backward move -- correcting a mis-drag without opening
// a terminal -- only if `force` reaches the CLI. It travels the same way
// `evidence` does; before this it was dropped at the HTTP boundary and the
// move was refused despite the UI having offered it.
test('a backward move from the board is accepted when it asks for force, and refused when it does not', async () => {
  await withServer(async ({ url, store }) => {
    await write(url, '/api/items/P1-01/move', { to: 'building' });
    assert.equal(store.readItems()[0].stage, 'building');

    const withoutForce = await write(url, '/api/items/P1-01/move', { to: 'backlog' });
    // 409, the status this API uses for a rule violation, not 400.
    assert.equal(withoutForce.status, 409, 'a backward move is force-only by definition');
    assert.equal(store.readItems()[0].stage, 'building', 'and nothing moved');

    const forced = await write(url, '/api/items/P1-01/move', { to: 'backlog', force: true });
    assert.equal(forced.status, 200);
    assert.equal(store.readItems()[0].stage, 'backlog', 'the human corrected their own mistake from the board');
  });
});

// "Someone must have claimed it" is answered by a Claim button, not by telling
// a person with a mouse to run a CLI command.
test('claim and release are reachable from the board', async () => {
  await withServer(async ({ url, store }) => {
    // The fixture item ships already owned, so release first -- claiming an
    // owned item is correctly refused, and that refusal is worth pinning too.
    const reclaim = await write(url, '/api/items/P1-01/claim', {});
    assert.equal(reclaim.status, 409, 'an already-owned item cannot be silently taken');

    const released = await write(url, '/api/items/P1-01/release', {});
    assert.equal(released.status, 200);
    assert.equal(store.readItems()[0].owner, null);

    const claimed = await write(url, '/api/items/P1-01/claim', {});
    assert.equal(claimed.status, 200);
    assert.match(store.readItems()[0].owner, /^human:/, 'the board records a real actor, not an anonymous write');
  });
});
