import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createScheduler } from '../lib/run/scheduler.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { spawn } from 'node:child_process';
import { createRunner } from '../lib/run/spawn.js';

// createScheduler's default lifecycle defaults to process.platform, so on real Windows CI
// tick()'s unconditional enforceTimeouts() call would otherwise shell out to the real
// taskkill.exe/powershell.exe from lib/run/spawn.js to reap this test's own live process.
// Those execFileSync calls have no timeout, and a hung or slow external process there
// hangs the whole job silently (see P6-05). This test doesn't exercise signal-ignoring
// semantics, so Node's process.kill — which Windows always treats as an unconditional
// TerminateProcess, regardless of signal name — reaps it just as reliably, without ever
// invoking an external process. Windows-specific escalation mechanics (real taskkill argv,
// the pid-reuse identity guard) are covered deterministically by run-lifecycle-windows.test.js.
// `started` should echo the fixture's recorded durable `started` timestamp.
// The real windowsProcessStartTime() reports a live process's actual, fixed
// OS creation time, compared by the win32 identity guard against the
// recorded `started` within a small tolerance to rule out pid reuse. A
// fixture that backdates `started` to fast-forward run_timeout_min needs the
// stub to agree with that backdated value, or the guard fails closed and the
// test's own process is never signalled.
function winSafeKill(started) {
  return process.platform !== 'win32' ? {} : {
    taskkillFn: (pid, { force }) => { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} return { timedOut: false }; },
    windowsStartTimeFn: () => ({ startTime: started ? Date.parse(started) : Date.now(), timedOut: false }),
  };
}

const stages = { stages: [{ id: 'backlog' }, { id: 'specified', auto: true, requires: { deps_at_least: 'specified' } }, { id: 'done', auto: false }], terminal: ['done'] };

function item(id, extra = {}) {
  return { id, title: id, scope: '', notes: '', stage: 'backlog', flag: null, deps: [], priority: 'P1', updated: '2026-01-02T00:00:00.000Z', ...extra };
}

function board({ items = [], events = [], runner = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-scheduler-'));
  const store = createStore(root); store.ensure(); mkdirSync(join(root, '.gatewright', 'runs'));
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ vocab: { priority: ['P0', 'P1', 'P2'] }, runner: { enabled: true, provider: 'fixture', providers: { fixture: { cmd: ['fixture', '{prompt}'] } }, max_concurrent: 1, ...runner } }));
  writeFileSync(store.paths.prompt, '{{title}}'); store.writeItems(items);
  for (const event of events) store.appendEvent(event);
  return store;
}

function scheduler(store, { registry = { list: () => ({ records: [] }) }, calls = [] } = {}) {
  return {
    calls,
    scheduler: createScheduler({
      store, registry, makeRunId: () => 'r-test',
      worktree: { ensure: ({ root, item: candidate }) => ({ path: join(root, '.gatewright', '.worktrees', candidate.id), reused: false }) },
      runner: { start(args) { calls.push(args); return { provider: 'fixture' }; } },
    }),
  };
}

// Bounded so a platform divergence in child-process exit reporting fails with a
// message instead of hanging the job silently (see P6-05).
function onceClose(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the child process to close')), ms);
    child.once('close', (...args) => { clearTimeout(timer); resolve(args); });
  });
}

async function waitUntil(predicate, timeout, message) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started >= timeout) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('max_concurrent refuses the second eligible item before its provider boundary', () => {
  const first = item('P1-01'); const second = item('P1-02', { updated: '2026-01-03T00:00:00.000Z' });
  const store = board({ items: [first, second], events: [{ type: 'dispatch', item: first.id }, { type: 'dispatch', item: second.id }] });
  const records = []; const registry = { list: () => ({ records }), record() {} };
  const { scheduler: subject, calls } = scheduler(store, { registry });
  subject.tick();
  records.push({ run: 'r-test', item: first.id });
  subject.tick();
  assert.equal(calls.length, 1);
});

test('held, blocked, terminal, and dependency-blocked items are never picked', () => {
  const held = item('P1-01', { flag: 'needs-triage' });
  const blocked = item('P1-02', { flag: 'blocked' });
  const terminal = item('P1-03', { stage: 'done' });
  const unmet = item('P1-04', { deps: ['P1-05'] }); const dependency = item('P1-05', { stage: 'backlog' });
  const items = [held, blocked, terminal, unmet, dependency];
  const store = board({ items, events: [held, blocked, terminal, unmet].map((entry) => ({ type: 'dispatch', item: entry.id })) });
  const { scheduler: subject, calls } = scheduler(store); subject.tick();
  assert.equal(calls.length, 0);
});

test('paused runner makes zero spawns', () => {
  const candidate = item('P1-01'); const store = board({ items: [candidate], events: [{ type: 'dispatch', item: candidate.id }], runner: { paused: true } });
  const { scheduler: subject, calls } = scheduler(store); assert.equal(subject.tick().status, 'paused'); assert.equal(calls.length, 0);
});

test('scheduler is inert until runner.enabled is explicitly true', () => {
  const candidate = item('P1-01'); const store = board({ items: [candidate], events: [{ type: 'dispatch', item: candidate.id }], runner: { enabled: false } });
  const { scheduler: subject, calls } = scheduler(store); assert.equal(subject.tick().status, 'disabled'); assert.equal(calls.length, 0);
});

test('enabled scheduler with no provider gives a clear inert result', () => {
  const candidate = item('P1-01'); const store = board({ items: [candidate], events: [{ type: 'dispatch', item: candidate.id }], runner: { provider: null } });
  const { scheduler: subject, calls } = scheduler(store); const result = subject.tick();
  assert.equal(result.status, 'unconfigured'); assert.match(result.message, /provider/); assert.equal(calls.length, 0);
});

test('priority order wins and an unknown priority sorts last', () => {
  const unknown = item('P1-01', { priority: 'P9', updated: '2026-01-01T00:00:00.000Z' });
  const p1 = item('P1-02', { priority: 'P1', updated: '2026-01-03T00:00:00.000Z' });
  const p0 = item('P1-03', { priority: 'P0', updated: '2026-01-04T00:00:00.000Z' });
  const store = board({ items: [unknown, p1, p0], events: [unknown, p1, p0].map((entry) => ({ type: 'dispatch', item: entry.id })) });
  const { scheduler: subject, calls } = scheduler(store); subject.tick(); assert.equal(calls[0].item.id, 'P1-03');
});

test('registry-derived concurrency survives a simulated scheduler restart', () => {
  const candidate = item('P1-01'); const store = board({ items: [candidate], events: [{ type: 'dispatch', item: candidate.id }] });
  const registry = createRunRegistry({ store }); registry.record({ run: 'r-live', item: 'elsewhere', pid: process.pid });
  const { scheduler: subject, calls } = scheduler(store, { registry });
  assert.equal(subject.tick().status, 'at_capacity'); assert.equal(calls.length, 0);
});

test('no re-dispatch after run_ended prevents the overnight budget burn loop', () => {
  const candidate = item('P1-01');
  const store = board({ items: [candidate], events: [{ type: 'dispatch', item: candidate.id }, { type: 'run_ended', item: candidate.id, run: 'r-old', outcome: 'ok' }] });
  const { scheduler: subject, calls } = scheduler(store); subject.tick(); assert.equal(calls.length, 0);
});

test('a fresh scheduler instance enforces a timeout from the durable record started time before paused admission', async () => {
  const store = board({ runner: { paused: true, run_timeout_min: 1, stop_timeout_s: 0.01 } }); const worktree = join(store.root, 'worktree'); mkdirSync(worktree);
  store.writeItems([item('P1-01', { stage: 'backlog', owner: 'agent:r-old' })]);
  const proc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: 'ignore', cwd: worktree });
  const started = new Date(Date.now() - 61_000).toISOString();
  const registry = createRunRegistry({ store }); registry.record({ run: 'r-old', item: 'P1-01', pid: proc.pid, worktree, started });
  try {
    // This is intentionally a newly-created scheduler, modelling a restarted
    // supervisor whose only clock is the durable registry timestamp.
    const restarted = createScheduler({ store, registry, lifecycle: createRunLifecycle({ store, registry, ...winSafeKill(started) }) });
    assert.equal(restarted.tick().status, 'paused');
    // Poll rather than sleep. This waits on a SIGTERM the child ignores, a
    // SIGKILL escalation, and the OS reaping the process; a fixed delay makes
    // the test a measure of machine load rather than of behaviour. It returns
    // the instant the condition holds, so the generous ceiling costs nothing.
    await waitUntil(() => {
      try { process.kill(proc.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
    }, 15000, 'timed out waiting for the run process to be reaped');
    assert.throws(() => process.kill(proc.pid, 0), { code: 'ESRCH' });
    await waitUntil(() => store.readEvents().at(-1)?.outcome === 'timeout', 15000,
      'timed out waiting for the timeout run_ended event');
    assert.equal(store.readEvents().at(-1).outcome, 'timeout');
  } finally { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { process.kill(proc.pid, 'SIGKILL'); } catch {} } }
});

test('a normally completed run frees capacity so the next tick starts the next queued item', async () => {
  const first = item('P1-01'); const second = item('P1-02', { updated: '2026-01-03T00:00:00.000Z' });
  const store = board({ items: [first, second], events: [{ type: 'dispatch', item: first.id }, { type: 'dispatch', item: second.id }] });
  const firstTree = join(store.root, 'first'); const secondTree = join(store.root, 'second'); mkdirSync(firstTree); mkdirSync(secondTree);
  let sequence = 0;
  const runner = createRunner({ spawnFn: (_argv, options) => spawn(process.execPath, ['-e', 'process.exit(0)'], options) });
  const subject = createScheduler({ store, runner, makeRunId: () => `r-${++sequence}`, worktree: { ensure: ({ item: candidate }) => ({ path: candidate.id === first.id ? firstTree : secondTree }) } });
  const initial = subject.tick(); await onceClose(initial.started.child);
  assert.equal(createRunRegistry({ store }).list().records.length, 0); assert.equal(store.readItems().find((entry) => entry.id === first.id).owner, null);
  const next = subject.tick();
  assert.equal(next.status, 'started'); assert.equal(next.item, second.id);
  await onceClose(next.started.child);
});
