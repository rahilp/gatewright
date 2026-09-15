import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMemory } from '../lib/memory/provider.js';
import { memoryRecord } from '../lib/memory/write.js';
import { createRunner } from '../lib/run/spawn.js';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { run as move } from '../lib/commands/move.js';
import { run as brief } from '../lib/commands/brief.js';

function board() {
  const root = mkdtempSync(join(tmpdir(), 'gw-memory-'));
  mkdirSync(join(root, '.gatewright'));
  writeFileSync(join(root, '.gatewright', 'prompt.md'), '## Prior context\n{{prior_context}}\n{{capsule}}');
  return root;
}
const item = { id: 'P5-04', title: 'Memory recall', scope: 'wire dispatch', stage: 'specified', deps: [], notes: '' };
function config(memory) { return { runner: { provider: 'stub', prompt_template: '.gatewright/prompt.md', providers: { stub: { cmd: ['agent', '{prompt}'] } } }, memory }; }

test('default-off memory is disabled, makes no transport call, and leaves a dispatch empty', async () => {
  let calls = 0;
  const memory = createMemory({ config: {}, transport: { recall() { calls += 1; } } });
  assert.equal(memory.enabled, false); assert.deepEqual(await memory.recall('anything', 1), []);
  const root = board();
  const result = createRunner({ dryRun: true }).start({ config: config({ enabled: false }), item, run: 'r-1', worktree: root, root });
  assert.equal(calls, 0); assert.equal(result.prompt, '## Prior context\n\n');
});

test('injected transport formats and trims recall results and adds a capsule', async () => {
  const root = board();
  const result = await createRunner({ dryRun: true }).startWithMemory({ config: config({ enabled: true, provider: 'transport', project_id: 'gatewright', recall: { on_dispatch: true, top_k: 2, max_chars: 30 } }), item, run: 'r-1', worktree: root, root }, { transport: {
    recall: async () => [{ date: '2026-09-14', text: 'first remembered choice' }, { date: '2026-09-13', text: 'second remembered choice' }],
    capsule: async () => 'stable capsule',
  } });
  assert.match(result.prompt, /- \(2026-09-14\) first remembere/);
  assert.doesNotMatch(result.prompt, /second remembered/); assert.match(result.prompt, /stable capsule/);
});

test('hanging and throwing transports log warnings but never prevent a runner start', async () => {
  const root = board();
  const result = await createRunner({ dryRun: true }).startWithMemory({ config: config({ enabled: true, provider: 'transport', recall: { on_dispatch: true, top_k: 1, max_chars: 100 } }), item, run: 'r-1', worktree: root, root }, { transport: { recall: () => new Promise(() => {}) } });
  assert.equal(result.provider, 'stub'); assert.equal(result.prompt, '## Prior context\n\n');
  assert.match(readFileSync(join(root, '.gatewright', 'runs', 'memory.log'), 'utf8'), /timed out/);
  const throwing = createMemory({ config: { memory: { enabled: true, provider: 'transport' } }, transport: { remember() { throw new Error('offline'); } }, log: { root } });
  assert.equal(await throwing.remember('x', [], {}), null);
  assert.match(readFileSync(join(root, '.gatewright', 'runs', 'memory.log'), 'utf8'), /offline/);
});

test('memory adapters remain dynamic and lib/memory has no network primitive', () => {
  const directory = new URL('../lib/memory/', import.meta.url);
  const sources = [new URL('provider.js', directory), ...readdirSync(new URL('providers/', directory)).map((name) => new URL(`providers/${name}`, directory))];
  for (const file of sources) assert.doesNotMatch(readFileSync(file, 'utf8'), /node:(?:http|https)|\bfetch\s*\(/);
  const source = readFileSync(new URL('provider.js', directory), 'utf8');
  assert.match(source, /import\(`\.\/providers/);
  assert.doesNotMatch(source, /from ['"].*providers\//);
});

test('a disabled memory configuration does not import its adapter module', () => {
  const root = new URL('..', import.meta.url);
  const loader = new URL('./fixtures/import-trace-loader.mjs', import.meta.url);
  const code = "import { createMemory } from './lib/memory/provider.js'; createMemory({ config: { memory: { enabled: false, provider: 'transport' } } });";
  const result = spawnSync(process.execPath, ['--experimental-loader', loader.pathname, '--input-type=module', '--eval', code], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /ADAPTER/);
});

function writeBoard({ type = 'feature', enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-memory-write-'));
  const store = createStore(root); store.ensure(); mkdirSync(join(root, 'worktree'));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'building' }, { id: 'verified', requires: { evidence_min: 1 } }], terminal: ['verified'] }));
  writeFileSync(store.paths.config, JSON.stringify({
    github: { repo: 'owner/widget', close_on: 'verified' },
    memory: { enabled, provider: 'transport', remember: { on_run_ok: true, on_close: true, max_chars: 300, extra_tags: ['release'] } },
  }));
  store.writeItems([{ id: 'P5-06', title: 'Record completed work', type, phase: 'P5', stage: 'building', owner: 'agent:r-ok', scope: 'keep this reliable', notes: '[2026-09-14T00:00:00Z] chose deterministic text', evidence: ['deadbeef', 'lib/memory/write.js', 'https://ci.example.test/run/1', 'README.md', 'SECRET=value', 'VALIDATION-42'] }]);
  return { root, store, worktree: join(root, 'worktree') };
}
function flush() { return new Promise((resolve) => setImmediate(resolve)); }

test('one successful run records exactly one deterministic, capped memory with safe evidence', async () => {
  const fixture = writeBoard(); const calls = [];
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-ok', item: 'P5-06', pid: process.pid, worktree: fixture.worktree });
  const lifecycle = createRunLifecycle({ store: fixture.store, registry, gitHead: () => 'deadbeef', gitMessage: () => 'Add deterministic memory writer\nignored body', memoryTransport: { remember: (...args) => { calls.push(args); } } });
  lifecycle.finish({ run: 'r-ok' }, { code: 0 }); await flush();
  assert.equal(calls.length, 1);
  const [text, tags, options] = calls[0];
  assert.equal(text, 'owner/widget · P5-06 Record completed work · building→building · changed: Add deterministic memory writer · why: chose deterministic text · evidence: deadbeef, lib/memory/write.js, https://ci.example.test/run/1, README.md, (+2 evidence omitted)');
  assert.ok(text.length <= 300); assert.doesNotMatch(text, /SECRET/);
  assert.deepEqual(tags, ['gatewright', 'owner/widget', 'feature', 'P5', 'release']); assert.deepEqual(options, { volatility: 'state' });
});

test('an omission marker survives a memory cap by cutting evidence entries first', () => {
  const { text } = memoryRecord({
    root: '/tmp/widget', config: { memory: { remember: { max_chars: 170 } } },
    item: { id: 'P5-06', title: 'Record completed work', type: 'feature', phase: 'P5', scope: 'keep this reliable', evidence: ['deadbeef', 'test/memory.test.js', 'VALIDATION-42'] },
    from: 'building', to: 'verified', commitMessage: 'Complete deterministic memory writer',
  });
  assert.ok(text.length <= 170); assert.match(text, /\(\+1 evidence omitted\)$/); assert.doesNotMatch(text, /test\/memory/);
});

test('close records verified decisions as canonical durable memory and a run plus close makes two calls', async () => {
  const fixture = writeBoard({ type: 'decision' }); const calls = []; const transport = { remember: (...args) => { calls.push(args); } };
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-ok', item: 'P5-06', pid: process.pid, worktree: fixture.worktree });
  createRunLifecycle({ store: fixture.store, registry, gitMessage: () => 'Complete it', memoryTransport: transport }).finish({ run: 'r-ok' }, { code: 0 });
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: {}, positionals: ['P5-06', 'verified'], stdout: { write() {} }, memoryTransport: transport }); await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][2], { volatility: 'state' });
  assert.ok(calls[1][1].includes('verified')); assert.deepEqual(calls[1][2], { volatility: 'durable', canonical: true });
  for (const [text] of calls) assert.doesNotMatch(text, /run_ended|run_started|dispatch|"stage"|"type"/);
});

test('disabled memory never calls on completion or close, and a throwing backend cannot change the board', async () => {
  const fixture = writeBoard({ enabled: false }); let calls = 0;
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-ok', item: 'P5-06', pid: process.pid, worktree: fixture.worktree });
  createRunLifecycle({ store: fixture.store, registry, memoryTransport: { remember() { calls += 1; throw new Error('offline'); } } }).finish({ run: 'r-ok' }, { code: 0 });
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: {}, positionals: ['P5-06', 'verified'], stdout: { write() {} }, memoryTransport: { remember() { calls += 1; } } }); await flush();
  assert.equal(calls, 0); assert.equal(fixture.store.readItems()[0].stage, 'verified');
  const enabled = writeBoard(); const enabledRegistry = createRunRegistry({ store: enabled.store }); enabledRegistry.record({ run: 'r-throw', item: 'P5-06', pid: process.pid, worktree: enabled.worktree });
  createRunLifecycle({ store: enabled.store, registry: enabledRegistry, memoryTransport: { remember() { throw new Error('offline'); } } }).finish({ run: 'r-throw' }, { code: 0 }); await flush();
  assert.equal(enabled.store.readEvents().at(-1).type, 'run_ended'); assert.equal(enabled.store.readItems()[0].owner, null);
  const before = enabled.store.readItems();
  move({ store: enabled.store, root: enabled.root, actor: 'human:test', flags: {}, positionals: ['P5-06', 'verified'], stdout: { write() {} }, memoryTransport: { remember() { throw new Error('offline'); } } }); await flush();
  assert.equal(enabled.store.readItems()[0].stage, 'verified'); assert.notDeepEqual(enabled.store.readItems(), before);
});

test('brief has no memory call unless --recall, then renders related memory within its line cap', async () => {
  const fixture = writeBoard(); const config = JSON.parse(readFileSync(fixture.store.paths.config)); config.brief = { max_lines: 8 }; writeFileSync(fixture.store.paths.config, JSON.stringify(config));
  let calls = 0; let output = '';
  await brief({ store: fixture.store, root: fixture.root, flags: {}, stdout: { write(value) { output += value; } }, memoryTransport: { recall() { calls += 1; return []; } } });
  assert.equal(calls, 0);
  output = ''; await brief({ store: fixture.store, root: fixture.root, flags: { recall: true }, stdout: { write(value) { output += value; } }, memoryTransport: { recall(query, count) { calls += 1; assert.equal(query, 'Record completed work'); assert.equal(count, 3); return [{ date: '2026-09-14', text: 'use the proven approach' }]; } } });
  assert.equal(calls, 1); assert.match(output, /RELATED MEMORY/); assert.ok(output.trimEnd().split('\n').length <= 8);
});
