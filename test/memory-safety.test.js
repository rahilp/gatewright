import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../lib/memory/provider.js';
import { createStore } from '../lib/store.js';
import { createRunRegistry } from '../lib/run/registry.js';
import { createRunLifecycle } from '../lib/run/lifecycle.js';
import { createRunner } from '../lib/run/spawn.js';
import { run as move } from '../lib/commands/move.js';
import { run as brief } from '../lib/commands/brief.js';

const item = { id: 'P5-10', title: 'Memory safety', scope: 'prove the backend cannot block', stage: 'building', deps: [], notes: '', evidence: ['deadbeef'] };

function board({ enabled = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-memory-safety-'));
  const store = createStore(root); store.ensure(); mkdirSync(join(root, 'worktree'));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'building' }, { id: 'verified', requires: { evidence_min: 1 } }], terminal: ['verified'] }));
  writeFileSync(store.paths.config, JSON.stringify({
    github: { repo: 'owner/widget', close_on: 'verified' },
    runner: { provider: 'stub', prompt_template: '.gatewright/prompt.md', providers: { stub: { cmd: ['trap-agent', '{prompt}'] } } },
    memory: { enabled, provider: 'transport', timeout_ms: 25, recall: { on_dispatch: true, top_k: 1, max_chars: 200 }, remember: { on_run_ok: true, on_close: true, max_chars: 300 } },
  }));
  writeFileSync(join(root, '.gatewright', 'prompt.md'), 'Prior: {{prior_context}}\n{{capsule}}');
  store.writeItems([{ ...item, owner: 'agent:r-ok' }]);
  return { root, store, worktree: join(root, 'worktree') };
}

function logOf(root) { return readFileSync(join(root, '.gatewright', 'runs', 'memory.log'), 'utf8'); }
function flush() { return new Promise((resolve) => setImmediate(resolve)); }

async function dispatchWith(transport) {
  const fixture = board();
  const trap = join(fixture.root, 'trap-agent-was-not-run');
  writeFileSync(trap, 'untouched');
  const result = await createRunner({ dryRun: true }).startWithMemory({ config: JSON.parse(readFileSync(fixture.store.paths.config)), item, run: 'r-dispatch', worktree: fixture.worktree, root: fixture.root }, { transport });
  assert.equal(result.provider, 'stub');
  assert.equal(existsSync(join(fixture.root, 'trap-agent')), false);
  assert.equal(readFileSync(trap, 'utf8'), 'untouched');
  return fixture;
}

test('P5-10: a hanging memory transport times out in 25ms; dispatch still starts and brief still renders', async () => {
  const fixture = await dispatchWith({ recall: () => new Promise(() => {}) });
  const hanging = { recall: () => new Promise(() => {}), remember: () => new Promise(() => {}) };
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-hang', item: item.id, pid: process.pid, worktree: fixture.worktree });
  createRunLifecycle({ store: fixture.store, registry, memoryTransport: hanging }).finish({ run: 'r-hang' }, { code: 0 });
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: hanging });
  let output = '';
  await brief({ store: fixture.store, root: fixture.root, flags: {}, stdout: { write(value) { output += value; } }, memoryTransport: { recall: () => new Promise(() => {}) } });
  assert.match(output, /gw · 0 open/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(logOf(fixture.root), /timed out after 25ms/);
});

test('P5-10: a throwing transport does not block dispatch, completion, close, or brief', async () => {
  const fixture = await dispatchWith({ recall: () => { throw new Error('offline'); } });
  const calls = [];
  const registry = createRunRegistry({ store: fixture.store });
  registry.record({ run: 'r-ok', item: item.id, pid: process.pid, worktree: fixture.worktree });
  createRunLifecycle({ store: fixture.store, registry, gitHead: () => 'deadbeef', memoryTransport: { remember: (...args) => { calls.push(args); throw new Error('offline'); } } }).finish({ run: 'r-ok' }, { code: 0 });
  await flush();
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: { remember: (...args) => { calls.push(args); throw new Error('offline'); } } });
  await flush();
  let output = '';
  await brief({ store: fixture.store, root: fixture.root, flags: {}, stdout: { write(value) { output += value; } }, memoryTransport: { recall: () => { throw new Error('offline'); } } });
  assert.ok(output.length > 0);
  assert.equal(calls.length, 2);
  assert.match(logOf(fixture.root), /offline/);
  assert.doesNotMatch(logOf(fixture.root), /memory-secret-token/);
});

test('P5-10: malformed recall data is no hits, while the run and brief continue', async () => {
  const fixture = await dispatchWith({ recall: () => ({ not: 'hits' }) });
  let output = '';
  await brief({ store: fixture.store, root: fixture.root, flags: {}, stdout: { write(value) { output += value; } }, memoryTransport: { recall: () => ({ malformed: true }) } });
  assert.ok(output.length > 0);
  assert.match(logOf(fixture.root), /malformed data/);
});

test('P5-10: disabled memory makes zero transport calls across dispatch, run, complete, close, and brief', async () => {
  const fixture = board({ enabled: false }); let calls = 0;
  const transport = new Proxy({}, { get() { calls += 1; throw new Error('transport called'); } });
  const config = JSON.parse(readFileSync(fixture.store.paths.config));
  const started = await createRunner({ dryRun: true }).startWithMemory({ config, item, run: 'r-off', worktree: fixture.worktree, root: fixture.root }, { transport });
  assert.equal(started.prompt, 'Prior: \n');
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-off', item: item.id, pid: process.pid, worktree: fixture.worktree });
  createRunLifecycle({ store: fixture.store, registry, memoryTransport: transport }).finish({ run: 'r-off' }, { code: 0 });
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: transport });
  await brief({ store: fixture.store, root: fixture.root, flags: { recall: true }, stdout: { write() {} }, memoryTransport: transport });
  assert.equal(calls, 0);
});

test('P5-11: completion and close each remember exactly once with the §14 content, and repeats stay quiet', async () => {
  const fixture = board(); const calls = [];
  const transport = { remember: (...args) => { calls.push(args); } };
  const registry = createRunRegistry({ store: fixture.store }); registry.record({ run: 'r-ok', item: item.id, pid: process.pid, worktree: fixture.worktree });
  const lifecycle = createRunLifecycle({ store: fixture.store, registry, gitHead: () => 'deadbeef', gitMessage: () => 'Add safe memory backend\nignored', memoryTransport: transport });
  lifecycle.finish({ run: 'r-ok' }, { code: 0 }); await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'owner/widget · P5-10 Memory safety · building→building · changed: Add safe memory backend · why: prove the backend cannot block · evidence: deadbeef');
  assert.deepEqual(calls[0][1], ['gatewright', 'owner/widget', 'work', 'unknown']);
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: transport }); await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'owner/widget · P5-10 Memory safety · building→verified · changed:  · why: prove the backend cannot block · evidence: deadbeef, cafebabe');
  assert.deepEqual(calls[1][1], ['gatewright', 'owner/widget', 'work', 'unknown', 'verified']);
  lifecycle.finish({ run: 'r-ok' }, { code: 0 });
  assert.throws(() => move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: transport }));
  await flush();
  assert.equal(calls.length, 2);
});

test('P5-11: reaching close_on without a completed run remembers exactly once with the close template', async () => {
  const fixture = board(); const calls = [];
  move({ store: fixture.store, root: fixture.root, actor: 'human:test', flags: { evidence: ['cafebabe'] }, positionals: [item.id, 'verified'], stdout: { write() {} }, memoryTransport: { remember: (...args) => { calls.push(args); } } }); await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'owner/widget · P5-10 Memory safety · building→verified · changed:  · why: prove the backend cannot block · evidence: deadbeef, cafebabe');
  assert.deepEqual(calls[0][1], ['gatewright', 'owner/widget', 'work', 'unknown', 'verified']);
});
