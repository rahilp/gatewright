import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run as add } from '../lib/commands/add.js';
import { isSchedulable } from '../lib/policy.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunner } from '../lib/run/spawn.js';
import { createScheduler } from '../lib/run/scheduler.js';
import { readConfig, readStages } from '../lib/config.js';
import { pathValue } from './fixtures/env.js';

// createRunLifecycle defaults to process.platform, so on real Windows CI stopAll() below
// would otherwise shell out to the real taskkill.exe/powershell.exe from lib/run/spawn.js
// to reap this test's own live process. Those execFileSync calls have no timeout, and a
// hung or slow external process there hangs the whole job silently (see P6-05). This test
// doesn't exercise signal-ignoring semantics, so Node's process.kill — which Windows always
// treats as an unconditional TerminateProcess, regardless of signal name — reaps it just as
// reliably, without ever invoking an external process. Windows-specific escalation mechanics
// are covered deterministically by run-lifecycle-windows.test.js.
// `started`, if given, should echo the fixture's recorded durable `started`
// timestamp — see test/run-lifecycle.test.js's winSafeKill() for why: a
// fixture that backdates `started` needs the stub to agree with it, or the
// win32 pid-reuse guard fails closed. This file's own call site never
// backdates, so it always gets "now".
function winSafeKill(started) {
  return process.platform !== 'win32' ? {} : {
    taskkillFn: (pid, { force }) => { try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} return { timedOut: false }; },
    windowsStartTimeFn: () => ({ startTime: started ? Date.parse(started) : Date.now(), timedOut: false }),
  };
}

const stages = { stages: [{ id: 'backlog' }, { id: 'specified', auto: true }, { id: 'done' }], terminal: ['done'] };

function fixture({ autoDispatch }) {
  const root = mkdtempSync(join(tmpdir(), 'gw-runaway-')); const traps = mkdtempSync(join(tmpdir(), 'gw-provider-traps-'));
  for (const name of ['claude', 'codex', 'gemini']) writeFileSync(join(traps, name), `#!/bin/sh\ntouch '${join(traps, 'INVOKED')}'\nexit 97\n`, { mode: 0o755 });
  const store = createStore(root); store.ensure(); mkdirSync(join(store.dir, 'runs'));
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ id_scheme: 'seq', vocab: { priority: ['P1'] }, runner: { enabled: true, provider: 'stub', providers: { stub: { cmd: ['claude', '{prompt}'] } }, max_concurrent: 2, stop_timeout_s: 0 }, policy: { triage_required_for: ['agent'], auto_dispatch_children: autoDispatch, max_children_per_item: 2, max_depth: 2 } }));
  writeFileSync(store.paths.prompt, '{{title}}');
  store.writeItems([{ id: 'T-0001', title: 'runaway root', scope: '', notes: '', stage: 'backlog', flag: null, owner: null, deps: [], priority: 'P1', parent: null, updated: '2026-01-01T00:00:00.000Z' }]);
  store.appendEvent({ type: 'dispatch', item: 'T-0001', by: 'human:test' });
  return { root, traps, store };
}

function runawayRunner(store, { longRunning = false } = {}) {
  let pid = 50_000; const children = new Map(); const processes = []; const refused = [];
  const runner = createRunner({ spawnFn(argv, options) {
    assert.equal(argv[0], 'claude'); assert.match(pathValue(options.env), /gw-provider-traps-/);
    const parent = options.env.GW_ITEM;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        add({ store, root: store.root, actor: options.env.GW_ACTOR, flags: { parent }, positionals: [`child ${attempt} of ${parent}`], stdout: { write() {} } });
        const child = store.readItems().at(-1); store.appendEvent({ type: 'dispatch', item: child.id, by: options.env.GW_ACTOR });
      } catch (error) { refused.push({ parent, error: error.message }); }
    }
    if (longRunning) { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: options.cwd, detached: true, stdio: 'ignore' }); processes.push(child); return child; }
    const child = new EventEmitter(); child.pid = ++pid; children.set(parent, child); return child;
  } });
  return { runner, children, processes, refused };
}

function schedulerFor(store, registry, runner) {
  let run = 0;
  return createScheduler({ store, registry, runner, makeRunId: () => `runaway-${++run}`, worktree: { ensure: ({ root, item }) => { const path = join(root, '.worktrees', item.id); mkdirSync(path, { recursive: true }); return { path }; } } });
}

function assertTick(store, registry, { held }) {
  const items = store.readItems(); const context = { config: readConfig(store), stages: readStages(store), items };
  assert.ok(registry.list().records.length <= 2, 'max_concurrent holds at every tick');
  if (held) {
    const agentItems = items.filter((entry) => entry.created_by?.startsWith('agent:'));
    assert.ok(agentItems.every((entry) => entry.flag === 'needs-triage'), 'default policy holds every agent-created item');
    assert.ok(agentItems.every((entry) => !isSchedulable(entry, context)), 'held agent-created items are never schedulable');
  }
}

test('P4-18 runaway guard holds agent-created children, refuses caps at add time, and stabilizes', async () => {
  const subject = fixture({ autoDispatch: false }); const priorPath = process.env.PATH; process.env.PATH = `${subject.traps}${delimiter}${priorPath}`;
  try {
    const registry = createRunRegistry({ store: subject.store }); const stub = runawayRunner(subject.store); const scheduler = schedulerFor(subject.store, registry, stub.runner);
    const started = scheduler.tick(); assert.equal(started.status, 'started'); assertTick(subject.store, registry, { held: true });
    stub.children.get('T-0001').emit('close', 0); assertTick(subject.store, registry, { held: true });
    for (let tick = 0; tick < 20; tick += 1) { assert.equal(scheduler.tick().status, 'idle'); assertTick(subject.store, registry, { held: true }); }
    await new Promise((resolve) => setImmediate(resolve));
    const items = subject.store.readItems();
    assert.equal(items.length, 3, 'final count is one root plus the two permitted children');
    assert.equal(items.filter((entry) => entry.created_by?.startsWith('agent:')).length, 2);
    assert.equal(stub.refused.length, 1, 'the third child is refused by max_children_per_item during add');
    assert.match(stub.refused[0].error, /max_children_per_item/);
    assert.equal(registry.list().records.length, 0); assert.equal(items.filter((entry) => entry.owner != null).length, 0);
    assert.equal(existsSync(join(subject.traps, 'INVOKED')), false, 'PATH traps prove no real provider was invoked');
  } finally { process.env.PATH = priorPath; rmSync(subject.root, { recursive: true, force: true }); rmSync(subject.traps, { recursive: true, force: true }); }
});

test('P4-18 auto-dispatch is an explicit bounded policy choice and stop --all pauses the runaway', async () => {
  const subject = fixture({ autoDispatch: true }); const priorPath = process.env.PATH; process.env.PATH = `${subject.traps}${delimiter}${priorPath}`;
  let live;
  try {
    const registry = createRunRegistry({ store: subject.store }); const stub = runawayRunner(subject.store); const scheduler = schedulerFor(subject.store, registry, stub.runner);
    for (let tick = 0; tick < 20 && subject.store.readEvents().filter((event) => event.type === 'run_ended').length < 3; tick += 1) {
      const result = scheduler.tick(); assertTick(subject.store, registry, { held: false });
      if (result.status === 'started') { stub.children.get(result.item).emit('close', 0); assertTick(subject.store, registry, { held: false }); }
    }
    await new Promise((resolve) => setImmediate(resolve));
    const items = subject.store.readItems(); const starts = subject.store.readEvents().filter((event) => event.type === 'run_started');
    assert.equal(starts.length, 3, 'exact bounded spawn count: root plus its two permitted children');
    assert.equal(items.length, 3, 'final count is one root plus two children; max_depth prevents grandchildren');
    assert.ok(items.filter((entry) => entry.parent === 'T-0001').every((entry) => entry.flag == null && isSchedulable(entry, { config: readConfig(subject.store), stages: readStages(subject.store), items })));
    assert.equal(stub.refused.length, 7, 'root refuses one third child; each of two children refuses all three at max_depth');
    assert.ok(stub.refused.some((entry) => /max_children_per_item/.test(entry.error)));
    assert.equal(stub.refused.filter((entry) => /max_depth/.test(entry.error)).length, 6);
    assert.equal(registry.list().records.length, 0); assert.equal(items.filter((entry) => entry.owner != null).length, 0);

    assert.equal(existsSync(join(subject.traps, 'INVOKED')), false, 'PATH traps prove no real provider was invoked');
  } finally {
    if (live) for (const child of live.processes) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch {} } }
    process.env.PATH = priorPath; rmSync(subject.root, { recursive: true, force: true }); rmSync(subject.traps, { recursive: true, force: true });
  }
});

test('P4-18 stop --all pauses a live stub runaway and prevents later ticks from spawning', async () => {
  const subject = fixture({ autoDispatch: true }); const priorPath = process.env.PATH; process.env.PATH = `${subject.traps}${delimiter}${priorPath}`;
  let live;
  try {
    const registry = createRunRegistry({ store: subject.store }); live = runawayRunner(subject.store, { longRunning: true }); const scheduler = schedulerFor(subject.store, registry, live.runner);
    assert.equal(scheduler.tick().status, 'started'); assertTick(subject.store, registry, { held: false });
    const lifecycle = createRunLifecycle({ store: subject.store, registry, wait: () => {}, ...winSafeKill() }); lifecycle.stopAll();
    await new Promise((resolve) => setImmediate(resolve));
    const spawnCount = subject.store.readEvents().filter((event) => event.type === 'run_started').length;
    for (let tick = 0; tick < 10; tick += 1) assert.equal(scheduler.tick().status, 'paused');
    assert.equal(subject.store.readEvents().filter((event) => event.type === 'run_started').length, spawnCount, 'paused scheduler makes no further spawns');
    assert.equal(registry.list().records.length, 0); assert.equal(subject.store.readItems().filter((entry) => entry.owner != null).length, 0);
    assert.equal(existsSync(join(subject.traps, 'INVOKED')), false, 'PATH traps prove no real provider was invoked');
  } finally {
    if (live) for (const child of live.children.values()) { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { process.kill(child.pid, 'SIGKILL'); } catch {} } }
    process.env.PATH = priorPath; rmSync(subject.root, { recursive: true, force: true }); rmSync(subject.traps, { recursive: true, force: true });
  }
});
