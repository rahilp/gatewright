import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { readConfig, readStages } from '../lib/config.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createScheduler, selectCandidate } from '../lib/run/scheduler.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { spawn } from 'node:child_process';
import { createRunner } from '../lib/run/spawn.js';
import { superviseTick } from '../lib/commands/serve.js';

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

function scheduler(store, { registry = { list: () => ({ records: [] }), record() {} }, calls = [] } = {}) {
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

// ---------------------------------------------------------------------------
// T-0133 -- THE SUPERVISOR'S FOUR DEFECTS.
//
// tick() runs inside `gw serve`'s single event loop, on a timer, for every
// board that has the runner on. Everything below is about that: what it is
// allowed to cost, what it is allowed to take, what two of them are allowed to
// do at once, and what it is allowed to do when it fails.
// ---------------------------------------------------------------------------

// (a) The dispatch index. Rebuilding this as one pass over events must not
// quietly redefine what an outstanding dispatch IS. The semantics already
// written into events.jsonl -- and already shared with lib/brief.js's
// computeActive -- are: `dispatch` opens one, `run_ended` or `cancel` closes
// it, and nothing else touches it. `run_started` in particular does NOT close
// one: a live run is excluded by the registry, not by the event log, and a run
// that dies without a run_ended is reconciled into one rather than being
// silently forgotten.
test('the dispatch index keeps exactly the semantics events.jsonl already had', () => {
  const cases = [
    ['a dispatch with nothing after it is outstanding', [{ type: 'dispatch', item: 'P1-01' }], 'started'],
    ['run_ended closes it', [{ type: 'dispatch', item: 'P1-01' }, { type: 'run_ended', item: 'P1-01', run: 'r-1', outcome: 'ok' }], 'idle'],
    ['cancel closes it', [{ type: 'dispatch', item: 'P1-01' }, { type: 'cancel', item: 'P1-01' }], 'idle'],
    ['a re-dispatch after a close opens a new one', [{ type: 'dispatch', item: 'P1-01' }, { type: 'run_ended', item: 'P1-01', run: 'r-1', outcome: 'ok' }, { type: 'dispatch', item: 'P1-01' }], 'started'],
    ['run_started does not close it', [{ type: 'dispatch', item: 'P1-01' }, { type: 'run_started', item: 'P1-01', run: 'r-1' }], 'started'],
    ['an unrelated event never closes it', [{ type: 'dispatch', item: 'P1-01' }, { type: 'run_ended', item: 'P1-02', run: 'r-2', outcome: 'ok' }, { type: 'move', item: 'P1-01', from: 'backlog', to: 'backlog' }], 'started'],
    ['a close with no dispatch before it leaves nothing open', [{ type: 'run_ended', item: 'P1-01', run: 'r-1', outcome: 'ok' }], 'idle'],
  ];
  for (const [why, events, expected] of cases) {
    const store = board({ items: [item('P1-01')], events });
    assert.equal(scheduler(store).scheduler.tick().status, expected, why);
  }
});

// Counts how many times the event log is TRAVERSED, by trapping the reads
// `for...of` makes. Wall-clock cannot express this property honestly: the old
// walk's dominant cost was a per-candidate Map rebuild that is constant in the
// log length, so a same-items/longer-log ratio scored the OLD code better than
// the new one, and a same-log/more-items ratio left only a 6.7x-vs-1.8x gap
// between them -- a threshold in that gap is a measurement of the host, which is
// how this assertion first failed on Windows CI. A traversal count is the claim
// itself, exact on every machine.
function countingEvents(events) {
  const state = { passes: 0 };
  return new Proxy(events, {
    get(target, key) {
      if (key === 'passes') return state.passes;
      if (key === Symbol.iterator) state.passes += 1;
      // `target` as the receiver, so Array's methods and its internal slots are
      // reached directly and the trap never changes what the log reads as.
      return Reflect.get(target, key, target);
    },
  });
}

test('the dispatch index reads every item in one pass over the events, not one pass per item', () => {
  // The 100-vs-2000 comparison, in traversals rather than milliseconds: the
  // whole point is that this number does not grow with the board. A walk per
  // candidate makes it 1 + candidates (101, then 2001); one shared index makes
  // it 1, whatever the item count.
  const EVENTS = 5_000;
  function fixture(count) {
    const items = Array.from({ length: count }, (_, index) => item(`P1-${String(index).padStart(4, '0')}`));
    const store = board({ items });
    // Written straight to events.jsonl: appendEvent re-baselines the digest per
    // call, which would make building the fixture the slowest part of the test.
    const lines = Array.from({ length: EVENTS }, (_, index) => JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', type: 'dispatch', item: items[index % count].id }));
    writeFileSync(store.paths.events, `${lines.join('\n')}\n`);
    return { store, config: readConfig(store), stages: readStages(store), items: store.readItems(), events: store.readEvents() };
  }

  // selectCandidate() is measured because it is exactly what tick() calls --
  // asserted below, so this can never drift into measuring a function production
  // no longer uses.
  let last = null;
  for (const count of [100, 2000]) {
    const fixed = fixture(count);
    const events = countingEvents(fixed.events);
    const candidate = selectCandidate({ ...fixed, events });
    assert.ok(candidate, `a board of ${count} items must have real work to pick, or the walk is never reached`);
    assert.equal(events.passes, 1, `${count} candidates over one log must read it once, not ${count + 1} times`);
    last = { store: fixed.store, candidate };
  }

  assert.equal(scheduler(last.store).scheduler.tick().item, last.candidate.id, 'tick() must pick exactly what the measured selection picked');
});

// (b) A claim is a lock, and the scheduler is not exempt from it. It used to
// overwrite item.owner unconditionally at the end of a tick, so an item a human
// had claimed to work on by hand was handed to an agent and the human's name
// disappeared from the board.
test('the scheduler never takes an item a human has claimed', () => {
  const store = board({ items: [item('P1-01', { owner: 'human:rahil' })], events: [{ type: 'dispatch', item: 'P1-01' }] });
  const { scheduler: subject, calls } = scheduler(store);
  assert.equal(subject.tick().status, 'idle', 'a claimed item is not schedulable work');
  assert.equal(calls.length, 0, 'and no provider was reached');
  assert.equal(store.readItems()[0].owner, 'human:rahil', "the human's claim is still theirs");
  assert.deepEqual(store.readEvents().filter((event) => event.type === 'run_started'), [], 'nothing was recorded as started');
});

test('an item still owned by an earlier agent run is left alone rather than taken over', () => {
  const store = board({ items: [item('P1-01', { owner: 'agent:r-previous' })], events: [{ type: 'dispatch', item: 'P1-01' }] });
  const { scheduler: subject, calls } = scheduler(store);
  assert.equal(subject.tick().status, 'idle');
  assert.equal(calls.length, 0);
  assert.equal(store.readItems()[0].owner, 'agent:r-previous', 'releasing a stale claim is reconcile\'s job, never a second dispatch\'s');
});

test('a claimed item at the front of the queue does not starve the one behind it', () => {
  const claimed = item('P1-01', { owner: 'human:rahil', priority: 'P0' });
  const free = item('P1-02', { priority: 'P1' });
  const store = board({ items: [claimed, free], events: [{ type: 'dispatch', item: 'P1-01' }, { type: 'dispatch', item: 'P1-02' }] });
  const { scheduler: subject, calls } = scheduler(store);
  const result = subject.tick();
  assert.equal(result.status, 'started');
  assert.equal(result.item, 'P1-02', 'skipping a claimed item must mean skipping it, not stopping at it');
  assert.equal(calls.length, 1);
});

// (c) Admission was check-then-act with nothing held: the tick read the record
// count, then did the expensive work (worktree creation), then spawned. Two
// supervisors on one board -- a stale `gw serve` and a fresh one, or one per
// checkout -- both passed the check and both spawned, so max_concurrent 1 ran
// two agents. Two real processes are impractical in a test; two schedulers over
// one board directory, with the second ticking inside the first's race window,
// is the same interleaving.
function supervisor(store, name, { onWorktree } = {}) {
  const registry = createRunRegistry({ store });
  const calls = [];
  const scheduler = createScheduler({
    store, registry, makeRunId: () => `r-${name}`,
    worktree: { ensure: ({ item: candidate }) => { onWorktree?.(); return { path: join(store.root, `${name}-${candidate.id}`) }; } },
    // Stands in for lib/run/spawn.js, which replaces the durable reservation
    // with the live child's pid the moment the provider is invoked.
    runner: { start(args) { calls.push(args); registry.record({ run: args.run, item: args.item.id, pid: process.pid }); return { provider: 'fixture' }; } },
  });
  return { scheduler, calls, registry };
}

test('two supervisors on one board cannot both admit past max_concurrent', () => {
  const store = board({ items: [item('P1-01'), item('P1-02')], events: [{ type: 'dispatch', item: 'P1-01' }, { type: 'dispatch', item: 'P1-02' }] });
  const second = supervisor(store, 'b');
  let raced = null;
  const first = supervisor(store, 'a', { onWorktree: () => { raced ??= second.scheduler.tick(); } });

  assert.equal(first.scheduler.tick().status, 'started');
  assert.equal(raced.status, 'at_capacity', 'the second supervisor must be refused by the first one\'s durable reservation');
  assert.equal(first.calls.length + second.calls.length, 1, 'max_concurrent 1 means one provider process, not two');
  assert.equal(createRunRegistry({ store }).list().records.length, 1);
  assert.equal(store.readEvents().filter((event) => event.type === 'run_started').length, 1);
});

test('two supervisors cannot both dispatch the same item even when there is capacity for two', () => {
  const store = board({ items: [item('P1-01')], events: [{ type: 'dispatch', item: 'P1-01' }], runner: { max_concurrent: 2 } });
  const second = supervisor(store, 'b');
  let raced = null;
  const first = supervisor(store, 'a', { onWorktree: () => { raced ??= second.scheduler.tick(); } });

  assert.equal(first.scheduler.tick().status, 'started');
  assert.notEqual(raced.status, 'started', 'two agents on one item is two agents editing one worktree');
  assert.equal(first.calls.length + second.calls.length, 1);
  assert.equal(store.readEvents().filter((event) => event.type === 'run_started').length, 1);
});

// (d) With config.memory.enabled, tick() returns a Promise. serve.js called it
// from a synchronous try/catch, so a rejection -- a worktree that cannot be
// created, a provider that is not executable -- was an unhandled rejection that
// killed `gw serve` and with it every live run's supervision.
// The scheduler's two start paths report failure the same way -- the
// synchronous one throws, the asynchronous one rejects -- so serve.js has one
// rule to apply instead of two. What the scheduler owes either way is that the
// admission it took is given back: a reservation that outlives a failed start
// parks the supervisor at at_capacity forever with nothing actually running,
// which is a worse failure than the crash because nothing reports it.
test('a failing async tick releases its admission and reports through the same rejection serve already handles', async () => {
  const store = board({ items: [item('P1-01')], events: [{ type: 'dispatch', item: 'P1-01' }] });
  const config = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  config.memory = { enabled: true };
  writeFileSync(store.paths.config, JSON.stringify(config));
  const registry = createRunRegistry({ store });
  const subject = createScheduler({
    store, registry, makeRunId: () => 'r-test',
    worktree: { ensure: () => ({ path: join(store.root, 'worktree') }) },
    runner: { start() { throw new Error('the synchronous path must not be reached'); }, startWithMemory: async () => { throw new Error('spawn ENOENT: provider is not executable'); } },
  });

  await assert.rejects(subject.tick(), /not executable/, 'the failure must reach the supervisor, not be swallowed into a silent idle tick');
  assert.deepEqual(registry.list().records, [], 'a failed start releases its reservation');
  assert.equal(store.readItems()[0].owner, null, 'and releases the claim it took to make it');
  assert.deepEqual(store.readEvents().filter((event) => event.type === 'run_started'), [], 'a run that never started is not recorded as started');
});

test('the serve supervisor loop survives a tick that throws and a tick that rejects', async () => {
  const lines = []; const stderr = { write: (text) => lines.push(text) };
  const seen = []; const onRejection = (error) => seen.push(error);
  process.on('unhandledRejection', onRejection);
  try {
    assert.doesNotThrow(() => superviseTick(() => { throw new Error('sync boom'); }, stderr));
    await superviseTick(() => Promise.reject(new Error('async boom')), stderr);
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.off('unhandledRejection', onRejection); }
  assert.deepEqual(seen, [], 'a tick rejection must never reach the process: it would take serve and every live run with it');
  assert.match(lines.join(''), /sync boom/, 'a synchronous failure is still reported');
  assert.match(lines.join(''), /async boom/, 'and so is a rejection');
});
