// The Windows termination and pid-reuse paths cannot run on this (Linux) CI
// host, so they are exercised here by forcing `platform: 'win32'` and
// injecting the command boundary. Real child processes stand in for the
// "agent" so liveness checks are real; the stub `taskkillFn`/`windowsStartTimeFn`
// play the parts `taskkill`/`Get-Process` would in production — their exact
// argv is asserted per §10.2, and { timedOut } lets tests simulate a wedged
// utility without ever shelling out to a real one (see P6-06).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';

function board({ timeout = 0.02 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-run-lifecycle-win-')); const store = createStore(root); store.ensure();
  mkdirSync(join(root, '.gatewright', 'runs'), { recursive: true }); mkdirSync(join(root, 'worktree'));
  writeFileSync(store.paths.config, JSON.stringify({ runner: { stop_timeout_s: timeout, paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }], terminal: [], extra: [{ id: 'paused', role: 'paused' }] }));
  store.writeItems([{ id: 'P4-07', title: 'fixture', stage: 'building', flag: null, owner: 'agent:r-1', updated: new Date().toISOString() }]);
  return { root, store, registry: createRunRegistry({ store }), worktree: join(root, 'worktree') };
}

function child(source, cwd) { return spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore', cwd }); }
function killFinally(proc) { try { process.kill(proc.pid, 'SIGKILL'); } catch {} }
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return original(chunk, ...rest); };
  try { return { result: await fn(), lines }; } finally { process.stderr.write = original; }
}
// { timedOut } is the contract lib/run/spawn.js's real taskkill()/windowsProcessStartTime()
// return; recording `opts.timeoutMs` alongside each call lets tests confirm lifecycle.js
// actually threads a real, positive timeout through, without asserting its exact value
// (that value is an internal tuning constant, not part of the contract under test).
function alwaysConfirms() { return (pid, { timeoutMs } = {}) => { assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'a real timeoutMs must be threaded through'); return { startTime: Date.now(), timedOut: false }; }; }

test('win32: escalation is skipped when the identity check can no longer confirm the process before force-closing', async () => {
  // Real subprocess reaping races with the synchronous, event-loop-free wait
  // this module deliberately uses (see pause()'s comment), so death cannot be
  // observed deterministically here. Instead this drives the exact case the
  // second identity check exists to guard: windowsStartTimeFn stops
  // confirming the pid (as Get-Process would once the process is gone, or on
  // a transient, non-timeout query failure) between the graceful request and
  // the escalation.
  const fixture = board(); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  const calls = []; let queries = 0;
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: () => { queries += 1; return { startTime: queries === 1 ? Date.now() : null, timedOut: false }; },
      taskkillFn: (pid, { force }) => { calls.push({ pid, force }); return { timedOut: false }; },
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'stopped');
    assert.deepEqual(calls, [{ pid: proc.pid, force: false }], 'the force-close call never happens once identity cannot be reconfirmed');
  } finally { killFinally(proc); }
});

test('win32: escalates from `taskkill /PID <pid> /T` to `taskkill /PID <pid> /T /F` when the agent ignores the request', async () => {
  const fixture = board({ timeout: 0.01 }); const proc = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", fixture.worktree);
  const calls = [];
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: alwaysConfirms(), // the process is genuinely still alive and unchanged both times
      taskkillFn: (pid, { force }) => { calls.push({ pid, force }); return { timedOut: false }; },
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'stopped');
    assert.deepEqual(calls, [{ pid: proc.pid, force: false }, { pid: proc.pid, force: true }]);
    assert.deepEqual(calls.map((call) => ['/PID', String(call.pid), '/T', ...(call.force ? ['/F'] : [])]), [
      ['/PID', String(proc.pid), '/T'],
      ['/PID', String(proc.pid), '/T', '/F'],
    ]);
  } finally { killFinally(proc); }
});

test('win32: stopping an already-dead recorded process is a clean no-op and never calls taskkill', async () => {
  const fixture = board(); const calls = [];
  fixture.registry.record({ run: 'r-dead', item: 'P4-07', pid: 99999999, worktree: fixture.worktree, started: new Date().toISOString() });
  const lifecycle = createRunLifecycle({ store: fixture.store, registry: fixture.registry, platform: 'win32', taskkillFn: (...args) => calls.push(args) });
  const result = await lifecycle.stopItem('P4-07');
  assert.equal(result[0].status, 'already_stopped');
  assert.equal(calls.length, 0);
});

test('win32: a live pid whose start time does not match the recorded run is never signalled (pid reuse)', async () => {
  const fixture = board(); const proc = child('setInterval(() => {}, 1000)', fixture.worktree); const calls = [];
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date('2020-01-01T00:00:00.000Z').toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: () => ({ startTime: Date.now(), timedOut: false }), // wildly different from the recorded start
      taskkillFn: (...args) => calls.push(args),
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'already_stopped');
    assert.equal(calls.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotThrow(() => process.kill(proc.pid, 0), 'the mismatched pid was left alone, not signalled');
  } finally { killFinally(proc); }
});

// --- P6-06: taskkill/Get-Process have no default timeout in production; these three
// simulate them wedging, without ever invoking a real external process. ---

test('win32: a graceful taskkill that never answers does not block escalation to force', async () => {
  const fixture = board({ timeout: 0.01 }); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  const calls = [];
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: alwaysConfirms(),
      taskkillFn: (pid, { force }) => { calls.push({ pid, force }); return { timedOut: !force }; }, // the graceful call hangs; the force call answers fine
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'stopped', 'a timed-out graceful step is not a reason to give up — force still runs and, having answered, is trusted');
    assert.deepEqual(calls, [{ pid: proc.pid, force: false }, { pid: proc.pid, force: true }], 'escalation to force still happens after the graceful call times out');
  } finally { killFinally(proc); }
});

test('win32: a force taskkill that never answers is reported unconfirmed, not stopped, and the run stays tracked', async () => {
  const fixture = board({ timeout: 0.01 }); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  const calls = [];
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: alwaysConfirms(),
      taskkillFn: (pid, { force }) => { calls.push({ pid, force }); return { timedOut: Boolean(force) }; }, // the force call is the one that hangs
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'stop_unconfirmed', 'a timed-out force call must never be reported as a confirmed stop');
    assert.deepEqual(calls, [{ pid: proc.pid, force: false }, { pid: proc.pid, force: true }]);

    const restored = fixture.registry.list().records;
    assert.equal(restored.length, 1, 'the run is put back so a later stop/timeout sweep gets another attempt');
    assert.equal(restored[0].run, 'r-1'); assert.equal(restored[0].pid, proc.pid);

    const item = fixture.store.readItems()[0];
    assert.equal(item.stage, 'building', 'ownership/stage is left untouched — the agent may still be running');
    assert.equal(item.owner, 'agent:r-1');
    assert.equal(fixture.store.readEvents().length, 0, 'no run_ended event claims a stop that could not be confirmed');
  } finally { killFinally(proc); }
});

test('win32: an identity probe that never answers fails open and still lets the kill switch signal', async () => {
  // Contrast with the pid-reuse test above: there, a *confirmed* mismatched
  // start time correctly refuses to signal. Here, the probe never confirms
  // anything either way — Get-Process itself is wedged — and the kill switch
  // must not go silently inert just because the host is degraded (see
  // lifecycle.js's looksLikeRecordedRun for the full reasoning). Since the
  // probe can never confirm the process is gone either, escalation runs all
  // the way to force — the fail-open guard would rather risk one harmless
  // extra taskkill call on an already-dead pid than skip force and leave a
  // possibly-live agent running.
  const fixture = board({ timeout: 0.01 }); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  const calls = [];
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: () => ({ startTime: null, timedOut: true }),
      taskkillFn: (pid, { force }) => { calls.push({ pid, force }); return { timedOut: false }; },
    });
    const { result, lines } = await captureStderr(() => lifecycle.stopItem('P4-07'));
    assert.equal(result[0].status, 'stopped');
    assert.deepEqual(calls, [{ pid: proc.pid, force: false }, { pid: proc.pid, force: true }], 'a wedged identity probe can never confirm the process is gone, so escalation proceeds all the way to force');

    const event = fixture.store.readEvents().at(-1);
    assert.equal(event.type, 'run_ended'); assert.equal(event.identity_unverified, true,
      'a kill made on a fail-open identity check must be permanently distinguishable in the audit trail from a confirmed one');

    assert.equal(lines.length, 2, 'both the graceful and force checks failed open and must each say so at the moment it happens');
    for (const line of lines) {
      assert.match(line, new RegExp(String(proc.pid)));
      assert.match(line, /timed out/);
    }
  } finally { killFinally(proc); }
});

test('win32: a confirmed identity (no timeout) never marks the run_ended event unverified', async () => {
  const fixture = board({ timeout: 0.01 }); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: alwaysConfirms(),
      taskkillFn: () => ({ timedOut: false }),
    });
    const { lines } = await captureStderr(() => lifecycle.stopItem('P4-07'));
    assert.equal(lines.length, 0, 'a fully confirmed stop must stay silent on stderr');
    const event = fixture.store.readEvents().at(-1);
    assert.equal('identity_unverified' in event, false, 'the field must be absent, not merely false, on an ordinary confirmed stop');
  } finally { killFinally(proc); }
});
