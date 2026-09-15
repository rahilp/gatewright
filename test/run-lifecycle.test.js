import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { createRunner } from '../lib/run/spawn.js';
import { createScheduler } from '../lib/run/scheduler.js';

function board({ timeout = 0.02 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-run-lifecycle-')); const store = createStore(root); store.ensure();
  mkdirSync(join(root, '.gatewright', 'runs'), { recursive: true }); mkdirSync(join(root, 'worktree'));
  writeFileSync(store.paths.config, JSON.stringify({ runner: { stop_timeout_s: timeout, run_timeout_min: 1, paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }], terminal: [], extra: [{ id: 'paused', role: 'paused' }] }));
  store.writeItems([{ id: 'P4-07', title: 'fixture', stage: 'building', flag: null, owner: 'agent:r-1', updated: new Date().toISOString() }]);
  return { root, store, registry: createRunRegistry({ store }), worktree: join(root, 'worktree') };
}

function child(source, cwd) { return spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore', cwd }); }
function waitGone(pid, tries = 40) { return new Promise((resolve) => { const tick = () => { try { process.kill(pid, 0); } catch { resolve(true); return; } if (!tries--) { resolve(false); return; } setTimeout(tick, 10); }; tick(); }); }
function killFinally(proc) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { process.kill(proc.pid, 'SIGKILL'); } catch {} } }
// Bounded so a platform divergence in child-process exit reporting fails with a
// message instead of hanging the job silently (see P6-05).
function onceClose(child, ms = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for the child process to close')), ms);
    child.once('close', (...args) => { clearTimeout(timer); resolve(args); });
  });
}
function providerConfig() { return { runner: { provider: 'fixture', prompt_template: '.gatewright/prompt.md', providers: { fixture: { cmd: ['fixture', '{prompt}'] } } } }; }
// createRunLifecycle defaults to process.platform, so on real Windows CI these calls
// would otherwise shell out to the real taskkill.exe/powershell.exe from lib/run/spawn.js
// to reap the test's own child processes. Those execFileSync calls have no timeout, and a
// hung or slow external process there hangs the whole job (this is what P6-05 fixed: a
// silent hang, not a failure). None of these fixtures test signal-ignoring semantics, so
// Node's process.kill — which Windows always treats as an unconditional TerminateProcess,
// regardless of signal name — reaps them just as reliably, without ever invoking an
// external process. Windows-specific escalation mechanics (real taskkill argv, the
// pid-reuse identity guard) are covered deterministically by run-lifecycle-windows.test.js.
// `started` should echo whatever the fixture recorded as the run's durable
// `started` timestamp (see board()/startedStub()'s `started` option). The real
// windowsProcessStartTime() reports a live process's actual, fixed OS creation
// time, which the win32 identity guard in lib/run/lifecycle.js compares
// against the recorded `started` within a small tolerance (see
// WINDOWS_PID_REUSE_TOLERANCE_MS) to rule out pid reuse. A fixture that
// deliberately backdates `started` — to fast-forward run_timeout_min without
// really waiting — needs the stub to agree with that backdated value, or the
// guard fails closed and the test's own process is never signalled. Fixtures
// that don't backdate `started` can omit this and get "now", matching the
// real started time recorded moments earlier.
function winSafeKill(started) {
  return process.platform !== 'win32' ? {} : {
    taskkillFn: (pid, { force }) => { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} return { timedOut: false }; },
    windowsStartTimeFn: () => ({ startTime: started ? Date.parse(started) : Date.now(), timedOut: false }),
  };
}
function startedStub(fixture, source, { started } = {}) {
  writeFileSync(fixture.store.paths.prompt, '{{title}}');
  const lifecycle = createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill() });
  const run = createRunner({ spawnFn: (_argv, options) => spawn(process.execPath, ['-e', source], options) }).start({ config: providerConfig(), item: fixture.store.readItems()[0], run: 'r-1', worktree: fixture.worktree, root: fixture.root, registry: fixture.registry, onExit: lifecycle.finish });
  if (started) fixture.registry.record({ ...run.record, started });
  return run;
}

test('stop SIGTERMs a recorded process, pauses the item, retains its worktree, and records cancellation', async () => {
  const fixture = board(); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, log: join(fixture.store.dir, 'runs', 'P4-07-r-1.log') });
    const result = await createRunLifecycle({ store: fixture.store, registry: fixture.registry, gitHead: () => 'deadbeef', ...winSafeKill() }).stopItem('P4-07');
    assert.equal(result[0].status, 'stopped'); assert.equal(await waitGone(proc.pid), true);
    const item = fixture.store.readItems()[0]; assert.equal(item.stage, 'paused'); assert.equal(item.flag, 'paused'); assert.equal(item.prev_stage, 'building'); assert.equal(item.last_commit, 'deadbeef');
    assert.equal(existsSync(fixture.worktree), true); assert.equal(fixture.registry.list().records.length, 0);
    assert.equal(fixture.store.readEvents().at(-1).outcome, 'cancelled');
  } finally { killFinally(proc); }
});

test('a SIGTERM-ignoring process is escalated to SIGKILL', {
  skip: process.platform === 'win32' ? 'Windows has no signal to ignore: process.kill there always terminates unconditionally, so this scenario cannot be modeled without shelling out to real taskkill/powershell; the escalation itself is covered by run-lifecycle-windows.test.js\'s "escalates from taskkill... when the agent ignores the request" test.' : false,
}, async () => {
  const fixture = board({ timeout: 0.01 }); const proc = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", fixture.worktree);
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree });
    await createRunLifecycle({ store: fixture.store, registry: fixture.registry }).stopItem('P4-07');
    assert.equal(await waitGone(proc.pid), true);
  } finally { killFinally(proc); }
});

test('stop all works with no server: it stops every record and persistently pauses the runner', async () => {
  const fixture = board(); const first = child('setInterval(() => {}, 1000)', fixture.worktree); const second = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    fixture.store.writeItems([{ id: 'P4-07', stage: 'building', flag: null }, { id: 'P4-08', stage: 'building', flag: null }]);
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: first.pid, worktree: fixture.worktree }); fixture.registry.record({ run: 'r-2', item: 'P4-08', pid: second.pid, worktree: fixture.worktree });
    await createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill() }).stopAll();
    assert.equal(await waitGone(first.pid), true); assert.equal(await waitGone(second.pid), true);
    assert.equal(JSON.parse((await import('node:fs')).readFileSync(fixture.store.paths.config, 'utf8')).runner.paused, true);
  } finally { killFinally(first); killFinally(second); }
});

test('a dead recorded run is a clean no-op', async () => {
  const fixture = board(); fixture.registry.record({ run: 'r-dead', item: 'P4-07', pid: 99999999, worktree: fixture.worktree });
  const result = await createRunLifecycle({ store: fixture.store, registry: fixture.registry }).stopItem('P4-07');
  assert.equal(result[0].status, 'already_stopped'); assert.equal(fixture.registry.list().records.length, 0); assert.equal(fixture.store.readEvents().length, 0);
});

test('timeout is measured from the durable started record, not this process lifetime', async () => {
  const fixture = board(); const proc = child("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", fixture.worktree);
  try {
    const started = new Date(Date.now() - 61_000).toISOString();
    fixture.registry.record({ run: 'r-old', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started });
    await createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill(started) }).enforceTimeouts();
    assert.equal(await waitGone(proc.pid), true); assert.equal(fixture.store.readEvents().at(-1).outcome, 'timeout');
  } finally { killFinally(proc); }
});

test('normal exit writes ok, releases ownership, clears capacity, and survives unavailable git metadata', async () => {
  const fixture = board(); writeFileSync(fixture.store.paths.prompt, '{{title}}');
  const lifecycle = createRunLifecycle({ store: fixture.store, registry: fixture.registry, gitHead: () => { throw new Error('no git'); } });
  const run = createRunner({ spawnFn: (_argv, options) => spawn(process.execPath, ['-e', 'process.exit(0)'], options) }).start({ config: providerConfig(), item: fixture.store.readItems()[0], run: 'r-ok', worktree: fixture.worktree, root: fixture.root, registry: fixture.registry, onExit: lifecycle.finish });
  await onceClose(run.child);
  const event = fixture.store.readEvents().at(-1);
  assert.equal(event.outcome, 'ok'); assert.equal(event.last_commit, null); assert.equal(fixture.store.readItems()[0].owner, null); assert.equal(fixture.registry.list().records.length, 0);
});

test('non-zero exit writes error and releases ownership', async () => {
  const fixture = board(); const run = startedStub(fixture, 'process.exit(7)');
  await onceClose(run.child);
  assert.equal(fixture.store.readEvents().at(-1).outcome, 'error'); assert.equal(fixture.store.readItems()[0].owner, null); assert.equal(fixture.registry.list().records.length, 0);
});

test('stop then close writes exactly one cancelled run_ended event', async () => {
  const fixture = board({ timeout: 0.01 }); const run = startedStub(fixture, 'setInterval(() => {}, 1000)');
  try {
    createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill() }).stopItem('P4-07');
    await onceClose(run.child);
    const ended = fixture.store.readEvents().filter((event) => event.type === 'run_ended');
    assert.deepEqual(ended.map((event) => event.outcome), ['cancelled']);
  } finally { killFinally(run.child); }
});

test('timeout then close writes exactly one timeout run_ended event', async () => {
  const started = new Date(Date.now() - 61_000).toISOString();
  const fixture = board({ timeout: 0.01 }); const run = startedStub(fixture, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", { started });
  try {
    createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill(started) }).enforceTimeouts();
    await onceClose(run.child);
    const ended = fixture.store.readEvents().filter((event) => event.type === 'run_ended');
    assert.deepEqual(ended.map((event) => event.outcome), ['timeout']);
  } finally { killFinally(run.child); }
});

test('resume dispatches its stopped-run log tail into the next dry-run rendered prompt', () => {
  const fixture = board(); const log = join(fixture.store.dir, 'runs', 'P4-07-r-1.log'); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    writeFileSync(log, 'known first line\nknown final line\n');
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, log });
    createRunLifecycle({ store: fixture.store, registry: fixture.registry, ...winSafeKill() }).stopItem('P4-07');
    const resumed = createRunLifecycle({ store: fixture.store, registry: fixture.registry }).resume('P4-07');
    assert.equal(fixture.store.readItems()[0].stage, 'building'); assert.equal(fixture.store.readItems()[0].flag, null); assert.equal(fixture.store.readEvents().at(-1).type, 'dispatch');
    assert.equal(resumed.promptValues.log_tail, 'known first line\nknown final line');

    writeFileSync(fixture.store.paths.stages, JSON.stringify({ stages: [{ id: 'building' }, { id: 'built', auto: true }], terminal: [], extra: [{ id: 'paused', role: 'paused' }] }));
    writeFileSync(fixture.store.paths.config, JSON.stringify({ runner: { enabled: true, provider: 'fixture', providers: { fixture: { cmd: ['fixture', '{prompt}'] } }, prompt_template: '.gatewright/prompt.md' } }));
    writeFileSync(fixture.store.paths.prompt, 'tail follows:\n{{log_tail}}');
    const scheduler = createScheduler({ store: fixture.store, registry: fixture.registry, runner: createRunner({ dryRun: true }), makeRunId: () => 'r-2', worktree: { ensure: () => ({ path: fixture.worktree }) } });
    const started = scheduler.tick().started;
    assert.match(started.prompt, /tail follows:\nknown first line\nknown final line/);
  } finally { killFinally(proc); }
});
