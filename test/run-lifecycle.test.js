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

test('stop SIGTERMs a recorded process, pauses the item, retains its worktree, and records cancellation', async () => {
  const fixture = board(); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, log: join(fixture.store.dir, 'runs', 'P4-07-r-1.log') });
    const result = await createRunLifecycle({ store: fixture.store, registry: fixture.registry, gitHead: () => 'deadbeef' }).stopItem('P4-07');
    assert.equal(result[0].status, 'stopped'); assert.equal(await waitGone(proc.pid), true);
    const item = fixture.store.readItems()[0]; assert.equal(item.stage, 'paused'); assert.equal(item.flag, 'paused'); assert.equal(item.prev_stage, 'building'); assert.equal(item.last_commit, 'deadbeef');
    assert.equal(existsSync(fixture.worktree), true); assert.equal(fixture.registry.list().records.length, 0);
    assert.equal(fixture.store.readEvents().at(-1).outcome, 'cancelled');
  } finally { killFinally(proc); }
});

test('a SIGTERM-ignoring process is escalated to SIGKILL', async () => {
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
    await createRunLifecycle({ store: fixture.store, registry: fixture.registry }).stopAll();
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
    fixture.registry.record({ run: 'r-old', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, started: new Date(Date.now() - 61_000).toISOString() });
    await createRunLifecycle({ store: fixture.store, registry: fixture.registry }).enforceTimeouts();
    assert.equal(await waitGone(proc.pid), true); assert.equal(fixture.store.readEvents().at(-1).outcome, 'timeout');
  } finally { killFinally(proc); }
});

test('resume dispatches its stopped-run log tail into the next dry-run rendered prompt', () => {
  const fixture = board(); const log = join(fixture.store.dir, 'runs', 'P4-07-r-1.log'); const proc = child('setInterval(() => {}, 1000)', fixture.worktree);
  try {
    writeFileSync(log, 'known first line\nknown final line\n');
    fixture.registry.record({ run: 'r-1', item: 'P4-07', pid: proc.pid, worktree: fixture.worktree, log });
    createRunLifecycle({ store: fixture.store, registry: fixture.registry }).stopItem('P4-07');
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
