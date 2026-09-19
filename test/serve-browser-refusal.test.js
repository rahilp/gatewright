import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';
import { runRouter } from '../lib/cli/router.js';

// T-0080: the needs-triage hold refuses the same action in two places -- the
// CLI terminal and the board's 409 body. The terminal keeps the command: it
// is runnable advice there. The board prints the refusal verbatim to a
// browser reader (T-0018: name a decision, never a command the reader cannot
// run), so both the triage self-approval and the triage hold on a move carry
// a browserMessage the server prefers. These tests pin both halves.

const item = (overrides = {}) => ({
  id: 'P1-01', title: 'Held item', phase: 'P1', priority: 'P1', type: 'feature', stage: 'backlog',
  flag: 'needs-triage', owner: null, scope: '', deps: [], evidence: [], notes: '', refs: [],
  parent: null, created_by: 'human:tester', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
  ...overrides,
});

async function withServer(fn, { item: theItem = item() } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-triage-'));
  const store = createStore(root); store.ensure(); store.writeItems([theItem]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'] }, runner: { paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building' }, { id: 'built', requires: { evidence_min: 1 } }], terminal: [], extra: [] }));
  store.rebaselineDigest();
  const server = createServeServer({ store });
  const address = await listen(server, { port: 0 });
  try { await fn({ root, store, url: `http://127.0.0.1:${address.port}` }); } finally { await new Promise((resolve) => server.close(resolve)); }
}

function write(url, path, body) {
  return fetch(url + path, { method: 'POST', headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

async function cliStderr(root, args) {
  let stderr = '';
  await runRouter(args, { cwd: root, env: { GW_ACTOR: 'agent:tester' }, stdout: { write() {} }, stderr: { write: (text) => { stderr += text; } } });
  return stderr;
}

test('the board triage refusal names the decision, never a CLI command', async () => {
  await withServer(async ({ root, url }) => {
    const response = await write(url, '/api/items/P1-01/triage', { action: 'approve', by: 'agent:tester' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /needs-triage/, 'the refusal still names the hold');
    assert.match(body.error, /different agent/, 'it names the required independent review boundary');
    assert.doesNotMatch(body.error, /gw triage/, 'and never a command a browser reader cannot run');
    assert.doesNotMatch(body.error, /`/, 'no backticks, no command syntax at all');
    // The terminal keeps its runnable advice -- the same refusal, audience split.
    const stderr = await cliStderr(root, ['triage', 'P1-01', '--approve']);
    assert.match(stderr, /gw triage P1-01 --drop/, 'the CLI gives the creator a command it can actually run');
  }, { item: item({ created_by: 'agent:tester' }) });
});

test('the board move refusal for a held item names the hold, not a command', async () => {
  await withServer(async ({ url }) => {
    const response = await write(url, '/api/items/P1-01/move', { to: 'building', evidence: [], by: 'human:other' });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /needs-triage/, 'the hold is named');
    assert.doesNotMatch(body.error, /gw triage/, 'and the browser reader is never sent to a terminal');
  });
});
