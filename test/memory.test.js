import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createMemory } from '../lib/memory/provider.js';
import { createRunner } from '../lib/run/spawn.js';

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
