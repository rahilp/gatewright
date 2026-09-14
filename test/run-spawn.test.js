import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const result = createRunner({ spawnFn: (argv, options) => { recordAtSpawn = calls.at(-1); assert.deepEqual(argv.slice(0, 2), ['agent', '--prompt']); assert.equal(options.env.GW_ACTOR, 'agent:r-42'); assert.equal(options.env.GW_ITEM, 'P1-01'); assert.equal(options.env.GW_ROOT, join(root, '.gatewright')); return child; } }).start({ config: config(), item, run: 'r-42', worktree, root, registry });
  assert.equal(recordAtSpawn.pid ?? null, null, 'durable reservation exists before the provider is invoked');
  assert.equal(calls.at(-1).pid, 424242);
  assert.equal(result.env.GW_ROOT, join(root, '.gatewright'));
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
