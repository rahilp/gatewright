import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../lib/memory/provider.js';
import { createProvider } from '../adapters/second-brain/memory.js';
import { createRunner } from '../lib/run/spawn.js';

const TOKEN = 'second-brain-test-token-should-never-appear';
const settings = { url: 'https://second-brain.invalid/mcp', token_env: 'SECOND_BRAIN_TEST_TOKEN' };
const recordedRecall = { result: { content: [{ type: 'text', text: JSON.stringify({ results: [
  { content: 'Keep prompt prefixes deterministic.', tags: ['gatewright', 'decision'], date: '2026-09-14' },
] }) }] } };
const recordedCapsule = { result: { content: [{ type: 'text', text: JSON.stringify({ prefix: 'Project capsule: stable context.\n' }) }] } };

function provider(transport, env = { SECOND_BRAIN_TEST_TOKEN: TOKEN }) {
  return createProvider({ config: { providers: { 'second-brain': settings } }, transport, env });
}

test('recorded recall maps MCP content to the memory interface without a network call', async () => {
  const requests = [];
  const memory = provider(async (url, request, token) => { requests.push({ url, request, token }); return recordedRecall; });
  assert.deepEqual(await memory.recall('prompt prefix', 3), [{ text: 'Keep prompt prefixes deterministic.', tags: ['gatewright', 'decision'], date: '2026-09-14' }]);
  assert.deepEqual(requests[0].request, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { query: 'prompt prefix', topK: 3 } } });
});

test('malformed recall becomes no hits and a warning at the never-fatal provider boundary', async () => {
  const output = [];
  const previous = process.env.SECOND_BRAIN_TEST_TOKEN; process.env.SECOND_BRAIN_TEST_TOKEN = TOKEN;
  const memory = createMemory({
    config: { memory: { enabled: true, provider: 'second-brain', providers: { 'second-brain': settings } } },
    transport: async () => ({ result: { content: [{ type: 'text', text: '{}' }] } }),
    log: (line) => output.push(line),
  });
  try { assert.deepEqual(await memory.recall('anything', 1), []); } finally {
    if (previous === undefined) delete process.env.SECOND_BRAIN_TEST_TOKEN; else process.env.SECOND_BRAIN_TEST_TOKEN = previous;
  }
  assert.match(output.join('\n'), /malformed/);
});

test('remember uses the documented tool and preserves volatility and canonical', async () => {
  const requests = [];
  const memory = provider(async (url, request, token) => { requests.push({ url, request, token }); return { result: { structuredContent: { id: 'memory-1' } } }; });
  assert.equal(await memory.remember('A verified decision', ['gatewright', 'verified'], { volatility: 'durable', canonical: true }), 'memory-1');
  assert.equal(requests[0].request.params.name, 'remember');
  assert.deepEqual(requests[0].request.params.arguments, { content: 'A verified decision', tags: ['gatewright', 'verified'], source: 'gatewright', volatility: 'durable', canonical: true });
});

test('capsule is returned verbatim and produces byte-identical prompt prefixes across calls', async () => {
  const requests = [];
  const memory = provider(async (url, request) => { requests.push({ url, request }); return recordedCapsule; });
  const first = await memory.capsule('gatewright');
  const second = await memory.capsule('gatewright');
  assert.equal(first, 'Project capsule: stable context.\n');
  assert.equal(Buffer.from(first).compare(Buffer.from(second)), 0);
  assert.deepEqual(requests[0].request.params, { name: 'get_prompt_capsule', arguments: { project_id: 'gatewright', kind: 'project' } });

  const root = mkdtempSync(join(tmpdir(), 'gw-second-brain-'));
  const prompt = join(root, 'prompt.md'); writeFileSync(prompt, '{{capsule}}');
  const config = { runner: { provider: 'stub', prompt_template: 'prompt.md', providers: { stub: { cmd: ['agent', '{prompt}'] } } } };
  const item = { id: 'P5-05', title: 'Capsule', scope: '', deps: [], stage: 'building', notes: '' };
  const runner = createRunner({ dryRun: true });
  const one = runner.start({ config, item, run: 'one', root, worktree: root, promptValues: { capsule: first } }).prompt;
  const two = runner.start({ config, item, run: 'two', root, worktree: root, promptValues: { capsule: second } }).prompt;
  assert.equal(Buffer.from(one).compare(Buffer.from(two)), 0);
});

test('missing token names its environment variable, makes no request, and never logs the token', async () => {
  let calls = 0; const output = [];
  const missingSettings = { ...settings, token_env: 'GW_SECOND_BRAIN_MISSING_TOKEN' };
  const memory = createMemory({
    config: { memory: { enabled: true, provider: 'second-brain', providers: { 'second-brain': missingSettings } } },
    transport: async () => { calls += 1; throw new Error(TOKEN); },
    log: (line) => output.push(line),
  });
  // Dynamic loading is asynchronous; the call awaits it before testing auth.
  assert.deepEqual(await memory.recall('anything', 1), []);
  assert.equal(calls, 0);
  assert.match(output.join('\n'), /GW_SECOND_BRAIN_MISSING_TOKEN/);
  assert.doesNotMatch(output.join('\n'), new RegExp(TOKEN));
});

test('a transport diagnostic containing the token is sanitized before it reaches logs', async () => {
  const output = []; const previous = process.env.SECOND_BRAIN_TEST_TOKEN;
  process.env.SECOND_BRAIN_TEST_TOKEN = TOKEN;
  const memory = createMemory({
    config: { memory: { enabled: true, provider: 'second-brain', providers: { 'second-brain': settings } } },
    transport: async () => { throw new Error(`authorization failed: ${TOKEN}`); },
    log: (line) => output.push(line),
  });
  try { assert.deepEqual(await memory.recall('anything', 1), []); } finally {
    if (previous === undefined) delete process.env.SECOND_BRAIN_TEST_TOKEN; else process.env.SECOND_BRAIN_TEST_TOKEN = previous;
  }
  assert.doesNotMatch(output.join('\n'), new RegExp(TOKEN));
  assert.match(output.join('\n'), /Second Brain recall request failed/);
});

test('adapter imports no packages and PATH traps prove no binary is invoked', async () => {
  const source = readFileSync(new URL('../adapters/second-brain/memory.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import\s/m);
  const trap = mkdtempSync(join(tmpdir(), 'gw-second-brain-path-'));
  const invoked = join(trap, 'INVOKED'); const binary = join(trap, 'curl');
  writeFileSync(binary, `#!/bin/sh\ntouch ${invoked}\n`); chmodSync(binary, 0o755);
  const memory = provider(async () => recordedRecall);
  const priorPath = process.env.PATH; process.env.PATH = `${trap}:${priorPath}`;
  try { await memory.recall('offline only', 1); } finally { process.env.PATH = priorPath; }
  assert.equal(existsSync(invoked), false, 'PATH trap proves the adapter did not invoke a binary');
});
