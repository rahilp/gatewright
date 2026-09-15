import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run as check } from '../lib/commands/check.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunner } from '../lib/run/spawn.js';
import { createScheduler } from '../lib/run/scheduler.js';

const stages = { stages: [{ id: 'backlog' }, { id: 'specified', auto: true }, { id: 'done' }], terminal: ['done'] };

function item(id) {
  return { id, title: id, scope: '', notes: '', stage: 'backlog', flag: null, owner: null, deps: [], priority: 'P1', updated: '2026-01-01T00:00:00.000Z' };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gw-overnight-'));
  const traps = mkdtempSync(join(tmpdir(), 'gw-provider-traps-'));
  for (const name of ['claude', 'codex', 'gemini']) writeFileSync(join(traps, name), `#!/bin/sh\ntouch '${join(traps, 'INVOKED')}'\nexit 97\n`, { mode: 0o755 });
  const store = createStore(root); store.ensure(); mkdirSync(join(store.dir, 'runs'));
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ vocab: { priority: ['P1'] }, runner: { enabled: true, provider: 'stub', providers: { stub: { cmd: ['claude', '{prompt}'] } }, max_concurrent: 2 } }));
  writeFileSync(store.paths.prompt, '{{title}}');
  store.writeItems(Array.from({ length: 5 }, (_, index) => item(`P1-0${index + 1}`)));
  for (const entry of store.readItems()) store.appendEvent({ type: 'dispatch', item: entry.id, by: 'human:test' });
  return { root, traps, store };
}

function immediateRunner() {
  let pid = 40_000;
  const children = new Map();
  const runner = createRunner({ spawnFn(argv, options) {
    assert.equal(argv[0], 'claude');
    assert.match(options.env.PATH, /gw-provider-traps-/);
    const child = new EventEmitter(); child.pid = ++pid;
    children.set(options.env.GW_ITEM, child);
    return child;
  } });
  return { runner, children };
}

function schedulerFor(store, registry, runner, ids) {
  let next = 0;
  return createScheduler({
    store, registry, runner,
    makeRunId: () => `overnight-${ids[next++]}`,
    worktree: { ensure: ({ root, item: candidate }) => ({ path: join(root, '.worktrees', candidate.id) }) },
  });
}

function assertTickInvariant(store, registry) {
  assert.ok(registry.list().records.length <= 2, 'never more than max_concurrent runs may be durable at a tick boundary');
  assert.ok(store.readItems().filter((entry) => entry.owner).length <= 2, 'never more than max_concurrent items may be owned at a tick boundary');
}

function assertTerminalBoard(store, registry) {
  const events = store.readEvents(); const items = store.readItems();
  assert.equal(registry.list().records.length, 0, 'completed work leaves no registry records');
  assert.equal(items.filter((entry) => entry.owner != null).length, 0, 'completed work leaves no owned item');
  for (const entry of items) {
    const starts = events.filter((event) => event.type === 'run_started' && event.item === entry.id);
    const ends = events.filter((event) => event.type === 'run_ended' && event.item === entry.id);
    assert.equal(starts.length, 1, `${entry.id} starts exactly once`);
    assert.equal(ends.length, 1, `${entry.id} ends exactly once`);
    assert.ok(events.indexOf(starts[0]) < events.indexOf(ends[0]), `${entry.id} cannot end before it starts`);
  }
  let report = ''; assert.equal(check({ store, flags: {}, stdout: { write: (text) => { report += text; } } }), 0, report);
}

test('P4-17 overnight queue drains five dispatched items, releases capacity after completion, and records one ordered terminal event each', async () => {
  const subject = fixture(); const priorPath = process.env.PATH; process.env.PATH = `${subject.traps}:${priorPath}`;
  try {
    const registry = createRunRegistry({ store: subject.store }); const { runner, children } = immediateRunner();
    const scheduler = schedulerFor(subject.store, registry, runner, ['01', '02', '03', '04', '05']);
    let failed = false;
    for (let tick = 0; tick < 20 && registry.list().records.length + subject.store.readEvents().filter((event) => event.type === 'run_ended').length < 5; tick += 1) {
      const result = scheduler.tick(); assertTickInvariant(subject.store, registry);
      if (result.status === 'started') {
        children.get(result.item).emit('close', result.item === 'P1-03' ? 1 : 0);
        failed ||= result.item === 'P1-03';
        assertTickInvariant(subject.store, registry);
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failed, true);
    const failures = subject.store.readEvents().filter((event) => event.type === 'run_ended' && event.outcome === 'error');
    assert.equal(failures.length, 1, 'a failing stub run is recorded as error');
    assert.equal(failures[0].item, 'P1-03');
    // This is the normal-exit regression guard: later items start only after
    // completed runs have released their durable capacity slots.
    assert.deepEqual(subject.store.readEvents().filter((event) => event.type === 'run_started').map((event) => event.item), ['P1-01', 'P1-02', 'P1-03', 'P1-04', 'P1-05']);
    assertTerminalBoard(subject.store, registry);
    assert.equal(existsSync(join(subject.traps, 'INVOKED')), false, 'PATH traps prove no real provider was invoked');
  } finally { process.env.PATH = priorPath; rmSync(subject.root, { recursive: true, force: true }); rmSync(subject.traps, { recursive: true, force: true }); }
});

test('P4-17 crash-mid-drain reconciles durable records and drains the remaining queue without double-runs', async () => {
  const subject = fixture(); const priorPath = process.env.PATH; process.env.PATH = `${subject.traps}:${priorPath}`;
  try {
    const registry = createRunRegistry({ store: subject.store }); const first = immediateRunner();
    let scheduler = schedulerFor(subject.store, registry, first.runner, ['01', '02', '03', '04', '05']);
    assert.equal(scheduler.tick().status, 'started'); assertTickInvariant(subject.store, registry);
    assert.equal(scheduler.tick().status, 'started'); assertTickInvariant(subject.store, registry);
    // Drop the supervisor while its stub pids are dead: startup reconciliation
    // owns those two terminal errors, then a new scheduler sees the same board.
    scheduler = null;
    assert.equal(registry.reconcile().cleaned.length, 2);
    assertTickInvariant(subject.store, registry);
    const replacement = immediateRunner(); scheduler = schedulerFor(subject.store, registry, replacement.runner, ['03', '04', '05']);
    for (let tick = 0; tick < 12 && subject.store.readEvents().filter((event) => event.type === 'run_ended').length < 5; tick += 1) {
      const result = scheduler.tick(); assertTickInvariant(subject.store, registry);
      if (result.status === 'started') { replacement.children.get(result.item).emit('close', 0); assertTickInvariant(subject.store, registry); }
    }
    await new Promise((resolve) => setImmediate(resolve));
    assertTerminalBoard(subject.store, registry);
    assert.equal(existsSync(join(subject.traps, 'INVOKED')), false, 'PATH traps prove no real provider was invoked');
  } finally { process.env.PATH = priorPath; rmSync(subject.root, { recursive: true, force: true }); rmSync(subject.traps, { recursive: true, force: true }); }
});
