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

async function withServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-write-'));
  const store = createStore(root); store.ensure(); store.writeItems([item]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'], gate: ['G0'] }, runner: { paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building' }, { id: 'built', requires: { evidence_min: 1 } }], terminal: [], extra: [] }));
  const server = createServeServer({ store }); const address = await listen(server, { port: 0 });
  try { await fn({ root, store, url: `http://127.0.0.1:${address.port}` }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function write(url, path, body, headers = {}) {
  return fetch(url + path, { method: 'POST', headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function rawWrite(url, path, body, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { method: 'POST', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
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
