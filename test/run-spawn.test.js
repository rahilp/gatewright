import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { createRunner } from '../lib/run/spawn.js';

function board() {
  const root = mkdtempSync(join(tmpdir(), 'gw-run-spawn-'));
  mkdirSync(join(root, '.gatewright'));
  writeFileSync(join(root, '.gatewright', 'prompt.md'), 'Item {{title}} / {{scope}} / {{target_stage}}');
  return root;
}

function config(overrides = {}) {
  return { runner: { provider: 'fixture', prompt_template: '.gatewright/prompt.md', providers: { fixture: { cmd: ['agent', '--prompt', '{prompt}', '--item', '{item}'] } }, ...overrides } };
}

const item = { id: 'P1-01', title: 'Runner foundation', scope: 'works offline', stage: 'specified', deps: [], notes: '' };

test('dry run renders exact argv without calling the process boundary', () => {
  const root = board(); let called = false;
  const result = createRunner({ dryRun: true, spawnFn: () => { called = true; } }).start({ config: config(), item, run: 'r-1', worktree: root, root, promptValues: { target_stage: 'building' } });
  assert.equal(called, false);
  assert.deepEqual(result.argv, ['agent', '--prompt', 'Item Runner foundation / works offline / building', '--item', 'P1-01']);
});

test('missing and unknown providers name the configuration key', () => {
  const root = board(); const runner = createRunner({ dryRun: true });
  assert.throws(() => runner.start({ config: { runner: { providers: {} } }, item, run: 'r-1', worktree: root, root }), /config\.runner\.provider/);
  assert.throws(() => runner.start({ config: config({ provider: 'missing' }), item, run: 'r-1', worktree: root, root }), /config\.runner\.providers\.missing/);
});

test('spawn carries main-board environment and persists a reservation before invoking the child boundary', () => {
  const root = board(); const worktree = join(root, 'worktree'); mkdirSync(worktree);
  const calls = []; let recordAtSpawn = null;
  const registry = { record(record) { calls.push(record); return record; } };
  const child = new PassThrough(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.once = (event, fn) => { if (event === 'close') child.on(event, fn); return child; };
  const result = createRunner({ spawnFn: (argv, options) => { recordAtSpawn = calls.at(-1); assert.deepEqual(argv.slice(0, 2), ['agent', '--prompt']); assert.equal(options.env.GW_ACTOR, 'agent:r-42'); assert.equal(options.env.GW_ITEM, 'P1-01'); assert.equal(options.env.GW_ROOT, root); return child; } }).start({ config: config(), item, run: 'r-42', worktree, root, registry });
  assert.equal(recordAtSpawn.pid ?? null, null, 'durable reservation exists before the provider is invoked');
  assert.equal(calls.at(-1).pid, 424242);
  assert.equal(result.env.GW_ROOT, root);
  assert.equal(result.log, join(root, '.gatewright', 'runs', 'P1-01-r-42.log'));
  child.emit('close');
});

test('only spawn.js owns child_process under lib/run', () => {
  const runDir = new URL('../lib/run/', import.meta.url);
  for (const file of readdirSync(runDir).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(new URL(file, runDir), 'utf8');
    if (file === 'spawn.js') assert.match(source, /node:child_process/);
    else assert.doesNotMatch(source, /node:child_process/);
  }
});

// A run log that cannot be opened must never take the supervisor down with it.
// An unhandled 'error' on the WriteStream would rethrow as an uncaught
// exception and kill `gw serve`, ending every *other* live run too.
test('an unwritable run log degrades to a warning and never kills the supervisor', async () => {
  const root = board(); const worktree = join(root, 'worktree'); mkdirSync(worktree);
  // A *directory* occupying the log's own path. Opening a directory for
  // writing fails on every platform, which a chmod-based setup would not --
  // Windows ignores mode bits. This is the portable stand-in for a read-only
  // checkout or a directory pulled out from under a live run.
  mkdirSync(join(root, '.gatewright', 'runs', 'P1-01-r-9.log'), { recursive: true });
  const child = new PassThrough(); child.pid = 4242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.once = (event, fn) => { if (event === 'close') child.on(event, fn); return child; };
  let warned = '';
  const runner = createRunner({ spawnFn: () => child, stderr: { write: (text) => { warned += text; } } });
  const result = runner.start({ config: config(), item, run: 'r-9', worktree, root });
  assert.equal(result.child.pid, 4242, 'the run still starts; only its transcript is lost');
  child.stdout.write('work continues\n');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(warned, /run r-9 log unavailable/);
  // The child must not be left with a stalled, unread pipe after the unpipe.
  assert.equal(child.stdout.isPaused(), false, 'output keeps draining so the agent never blocks on a full pipe');
  child.emit('close', 0);
});

test('a child with no pipes leaves no zero-byte log behind', async () => {
  const root = board(); const worktree = join(root, 'worktree'); mkdirSync(worktree);
  const child = new PassThrough(); child.pid = 77; child.once = () => child;
  const result = createRunner({ spawnFn: () => child }).start({ config: config(), item, run: 'r-7', worktree, root });
  // createWriteStream opens asynchronously, so checking straight away would
  // pass even if the stream had been created. Give the open a chance to land.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(existsSync(result.log), false, 'nothing could be captured, so nothing is written');
});

// spawn reports an unexecutable provider asynchronously. Unhandled, that is an
// uncaught exception killing the supervisor, and the durable reservation made
// before the spawn would survive it -- wedging the scheduler at at_capacity.
test('a provider that cannot be executed fails the run, not the supervisor', async () => {
  const root = board(); const worktree = join(root, 'worktree'); mkdirSync(worktree);
  const child = new PassThrough(); child.pid = 5150;
  const handlers = {};
  child.once = (event, fn) => { handlers[event] = fn; return child; };
  const ended = []; let warned = '';
  const registry = { record: (record) => record };
  const runner = createRunner({ spawnFn: () => child, stderr: { write: (text) => { warned += text; } } });
  runner.start({ config: config(), item, run: 'r-13', worktree, root, registry, onExit: (record, info) => ended.push({ record, info }) });

  handlers.error(Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' }));
  assert.match(warned, /run r-13 could not start \(ENOENT\)/);
  assert.equal(ended.length, 1, 'the run is ended so its capacity slot is released');
  assert.notEqual(ended[0].info.code, 0, 'it is ended as a failure, not a success');
  assert.equal(ended[0].record.run, 'r-13');
});
