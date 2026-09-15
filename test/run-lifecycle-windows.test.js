// The Windows termination and pid-reuse paths cannot run on this (Linux) CI
// host, so they are exercised here by forcing `platform: 'win32'` and
// injecting the command boundary. Real child processes stand in for the
// "agent" so liveness checks are real; the stub `taskkillFn` plays the part
// `taskkill` would in production, and its exact argv is asserted per §10.2.
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

test('win32: escalation is skipped when the identity check can no longer confirm the process before force-closing', async () => {
  // Real subprocess reaping races with the synchronous, event-loop-free wait
  // this module deliberately uses (see pause()'s comment), so death cannot be
  // observed deterministically here. Instead this drives the exact case the
  // second identity check exists to guard: windowsStartTimeFn stops
  // confirming the pid (as Get-Process would once the process is gone, or on
  // a transient query failure) between the graceful request and the escalation.
  const fixture = board(); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  const calls = []; let queries = 0;
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date().toISOString() });
    const lifecycle = createRunLifecycle({
      store: fixture.store, registry: fixture.registry, platform: 'win32',
      windowsStartTimeFn: () => { queries += 1; return queries === 1 ? Date.now() : null; },
      taskkillFn: (pid, opts) => { calls.push({ pid, ...opts }); return ['/PID', String(pid), '/T', ...(opts.force ? ['/F'] : [])]; },
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
      windowsStartTimeFn: () => Date.now(), // the process is genuinely still alive and unchanged both times
      taskkillFn: (pid, opts) => { calls.push({ pid, ...opts }); return ['/PID', String(pid), '/T', ...(opts.force ? ['/F'] : [])]; },
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
      windowsStartTimeFn: () => Date.now(), // wildly different from the recorded start
      taskkillFn: (...args) => calls.push(args),
    });
    const result = await lifecycle.stopItem('P4-07');
    assert.equal(result[0].status, 'already_stopped');
    assert.equal(calls.length, 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.doesNotThrow(() => process.kill(proc.pid, 0), 'the mismatched pid was left alone, not signalled');
  } finally { killFinally(proc); }
});
