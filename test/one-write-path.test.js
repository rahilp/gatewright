import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
// Excluded wall-clock values: created and updated are mutation timestamps;
// note-prefix timestamps are wall-clock values too. Note text remains strict.
const ACTOR = 'agent:p2-08';
const EXCLUDED_ITEM_FIELDS = new Set(['created', 'updated']);
const RULE_IDENTIFIERS = ['evaluateRequires', 'evaluateCumulative', 'findCycles'];

const fixture = {
  items: [{
    id: 'P2-01', title: 'Fixture item', phase: 'P2', priority: 'P2', type: 'feature',
    stage: 'specified', flag: null, owner: ACTOR, scope: 'fixture scope', deps: [], evidence: [],
    notes: '', refs: [], parent: null, created_by: 'human', gh: null,
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
  }],
  stages: {
    stages: [
      { id: 'backlog' },
      { id: 'specified' },
      { id: 'building', requires: { owner: true } },
      { id: 'built', requires: { evidence_min: 1 } },
    ],
    terminal: [], extra: [],
  },
  config: { version: 1, id_scheme: 'phase-seq', vocab: { phase: ['P2'], priority: ['P2'], type: ['feature'] } },
};

function makeBoard() {
  const root = mkdtempSync(join(tmpdir(), 'gw-one-write-path-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(structuredClone(fixture.items));
  writeFileSync(store.paths.stages, JSON.stringify(fixture.stages, null, 2) + '\n');
  writeFileSync(store.paths.config, JSON.stringify(fixture.config, null, 2) + '\n');
  return { root, store };
}

function comparableItems(items) {
  return items.map((item) => Object.fromEntries(
    Object.entries(item)
      .filter(([field]) => !EXCLUDED_ITEM_FIELDS.has(field))
      .map(([field, value]) => [field, field === 'notes' ? comparableNotes(value) : value]),
  ));
}

function comparableNotes(notes) {
  // Exclude only the documented [<ISO-8601 timestamp>] prefix on each note
  // line. The note text is intentionally retained byte-for-byte.
  return notes.split('\n').map((line) => line.replace(
    /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] /,
    '[<note-timestamp>] ',
  )).join('\n');
}

function comparableEvents(events) {
  return events.map(({ ts, ...event }) => event);
}

function runCli(root, args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, GW_ACTOR: ACTOR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let settled = false;
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { settled = true; resolve({ code, signal, stdout, stderr }); });
  });
  return { child, result, kill: () => { if (!settled) child.kill('SIGTERM'); } };
}

async function post(url, pathname, body) {
  const response = await fetch(url + pathname, {
    method: 'POST',
    headers: { Host: '127.0.0.1', Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function withServer(board, fn) {
  const server = createServeServer({
    store: board.store,
    env: { ...process.env, GW_ACTOR: ACTOR },
  });
  const address = await listen(server, { port: 0 });
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function assertWriteEquivalent(cliArgs, apiPath, apiBody, { refusedMove = false } = {}) {
  const cliBoard = makeBoard();
  const apiBoard = makeBoard();
  const cli = runCli(cliBoard.root, cliArgs);
  try {
    const cliResult = await cli.result;
    assert.equal(cliResult.code, refusedMove ? 1 : 0, cliResult.stderr);

    await withServer(apiBoard, async (url) => {
      const { response, body } = await post(url, apiPath, apiBody);
      if (refusedMove) {
        assert.equal(response.status, 409);
        const cliFailures = cliResult.stderr.trim().split('\n').slice(1);
        assert.deepEqual(body.failures, cliFailures);
      } else {
        assert.equal(response.status, 200, JSON.stringify(body));
      }
    });

    assert.deepEqual(comparableItems(apiBoard.store.readItems()), comparableItems(cliBoard.store.readItems()));
    assert.deepEqual(comparableEvents(apiBoard.store.readEvents()), comparableEvents(cliBoard.store.readEvents()));
    assert.deepEqual(apiBoard.store.readEvents().map((event) => event.by), cliBoard.store.readEvents().map((event) => event.by));
  } finally {
    cli.kill();
  }
}

test('CLI and HTTP move use one write path, including identical refused failures', async () => {
  await assertWriteEquivalent(['move', 'P2-01', 'built'], '/api/items/P2-01/move', { to: 'built', evidence: [] }, { refusedMove: true });
  await assertWriteEquivalent(['move', 'P2-01', 'building'], '/api/items/P2-01/move', { to: 'building', evidence: [] });
});

test('CLI and HTTP add use one write path', async () => {
  await assertWriteEquivalent(['add', 'Added through one path', '--phase', 'P2', '--priority', 'P2', '--type', 'feature', '--scope', 'same scope'], '/api/items', {
    title: 'Added through one path', phase: 'P2', priority: 'P2', type: 'feature', scope: 'same scope',
  });
});

test('CLI and HTTP edit use one write path', async () => {
  await assertWriteEquivalent(['edit', 'P2-01', '--scope', 'edited scope'], '/api/items/P2-01', { scope: 'edited scope' });
});

test('CLI and HTTP note use one write path', async () => {
  await assertWriteEquivalent(['note', 'P2-01', 'same note'], '/api/items/P2-01/note', { text: 'same note' });
});

test('serve does not reimplement the rules', () => {
  const serveDir = fileURLToPath(new URL('../lib/serve/', import.meta.url));
  const files = readdirSync(serveDir).filter((file) => file.endsWith('.js'));
  for (const file of files) {
    const source = readFileSync(join(serveDir, file), 'utf8');
    for (const identifier of RULE_IDENTIFIERS) {
      const localDefinition = new RegExp(`(?:function|class|const|let|var)\\s+${identifier}\\b|(?:export\\s+)?function\\s+${identifier}\\b`);
      assert.doesNotMatch(source, localDefinition, `${file} locally defines ${identifier}`);
    }
  }
});
