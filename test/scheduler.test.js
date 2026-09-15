import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createScheduler } from '../lib/run/scheduler.js';
import { spawn } from 'node:child_process';
import { createRunner } from '../lib/run/spawn.js';

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
  const registry = createRunRegistry({ store }); registry.record({ run: 'r-old', item: 'P1-01', pid: proc.pid, worktree, started: new Date(Date.now() - 61_000).toISOString() });
  try {
    // This is intentionally a newly-created scheduler, modelling a restarted
    // supervisor whose only clock is the durable registry timestamp.
    const restarted = createScheduler({ store, registry });
    assert.equal(restarted.tick().status, 'paused');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.throws(() => process.kill(proc.pid, 0), { code: 'ESRCH' });
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
  const initial = subject.tick(); await new Promise((resolve) => initial.started.child.once('close', resolve));
  assert.equal(createRunRegistry({ store }).list().records.length, 0); assert.equal(store.readItems().find((entry) => entry.id === first.id).owner, null);
  const next = subject.tick();
  assert.equal(next.status, 'started'); assert.equal(next.item, second.id);
  await new Promise((resolve) => next.started.child.once('close', resolve));
});
