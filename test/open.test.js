import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { readStages } from '../lib/config.js';
import { describeStage } from '../lib/gates/describe.js';
import { run as open } from '../lib/commands/open.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

const item = (over = {}) => ({
  id: 'P1-01', title: 'Repo scaffold', phase: 'P1', priority: 'P1', gate: 'G0',
  type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '',
  deps: [], evidence: [], notes: '', refs: [], parent: null,
  created_by: 'human', gh: null,
  created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z', ...over,
});

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gw-open-'));
  const store = createStore(root);
  store.ensure();
  return { root, store };
}

function extractBlock(html, id) {
  const re = new RegExp(`<script type="application\\/json" id="${id}">([\\s\\S]*?)<\\/script>`);
  const match = html.match(re);
  assert.ok(match, `expected a ${id} block in the written board.html`);
  return JSON.parse(match[1]);
}

// 15s, not 5: this polls for its condition and returns the instant it is true,
// so a longer deadline costs nothing when the machine is idle. It only matters
// under load — node --test runs files in parallel, and a shared CI runner makes
// a 5s deadline a false failure rather than a real one.
function waitFor(predicate, timeout = 15000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (predicate()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started >= timeout) return reject(new Error('timed out waiting for board update'));
      setTimeout(check, 25);
    };
    check();
  });
}

function startWatcher(root) {
  const child = spawn(process.execPath, [BIN, 'open', '--watch', '--no-browser'], { cwd: root });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  // stderr MUST be drained. An unread pipe fills and blocks or errors the
  // child — and the watcher now writes there on every skipped rebuild. It also
  // means a child that dies takes its explanation with it, which is exactly
  // what happened while diagnosing a Windows-only failure here.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errors += chunk; });
  return { child, output: () => output, errors: () => errors };
}

async function stopWatcher(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('gw open --no-browser writes .gatewright/board.html with the injected data', () => {
  const { root, store } = freshRoot();
  store.writeItems([item(), item({ id: 'P1-02', title: 'store.js' })]);
  store.appendEvent({ type: 'add', item: 'P1-01', by: 'human:rahil' });

  const out = execFileSync(process.execPath, [BIN, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /board\.html/);

  const html = readFileSync(store.paths.board, 'utf8');
  const items = extractBlock(html, 'gw-items');
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'P1-01');

  const events = extractBlock(html, 'gw-events');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'add');

  const stages = extractBlock(html, 'gw-stages');
  assert.ok(Array.isArray(stages.stages) && stages.stages.length > 0);

  const config = extractBlock(html, 'gw-config');
  assert.ok(config.generatedAt, 'config block should carry the snapshot timestamp');
});

// The offline snapshot has no server to ask, so if the sentences are not
// written into the file, `gw open --no-browser` shows a human raw JSON. This
// is the regression that would be invisible until someone opened a file:// board.
test('gw open --no-browser inlines the plain-English gate descriptions', () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  execFileSync(process.execPath, [BIN, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });

  const html = readFileSync(store.paths.board, 'utf8');
  const stages = extractBlock(html, 'gw-stages');
  const onDisk = readStages(store);
  assert.ok(stages.gates, 'the snapshot must carry a gates map, not just raw requires');

  for (const stage of [...onDisk.stages, ...(onDisk.extra || [])]) {
    assert.deepEqual(
      stages.gates[stage.id],
      describeStage(stage, onDisk),
      `${stage.id} must be described by lib/gates/describe.js, not by a copy of its wording`,
    );
    assert.ok(stages.gates[stage.id].sentences.length > 0);
  }
  // The shipped pipeline gates on evidence somewhere, so at least one sentence
  // reaches the file as English a human can read.
  const all = Object.values(stages.gates).flatMap((gate) => gate.sentences);
  assert.ok(all.some((line) => /evidence/i.test(line)), all.join(' | '));
});

test('gw open exits 0 and prints the board path on stdout', () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const out = execFileSync(process.execPath, [BIN, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });
  assert.match(out.trim(), /board\.html$/);
});

test('gw open prefers a reachable live board only when its complete state matches this project', async () => {
  const { store } = freshRoot();
  store.writeItems([item()]);
  const state = {
    items: store.readItems().map((entry) => ({ ...entry, can_release: false })),
    events: store.readEvents(), stages: readStages(store), config: (await import('../lib/config.js')).readConfig(store),
  };
  let output = '';
  await open({ store, flags: { port: '8123', 'no-browser': true }, stdout: { write(value) { output += value; } }, fetch: async () => ({ ok: true, json: async () => state }) });
  assert.equal(output, 'Gatewright live board: http://127.0.0.1:8123/\n');
  assert.ok(!existsSync(store.paths.board), 'a matching live board wins over a new snapshot');
});

test('gw open --watch rebuilds after a store change', async () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const watcher = startWatcher(root);
  try {
    await waitFor(() => existsSync(store.paths.board) && readFileSync(store.paths.board, 'utf8').includes('Repo scaffold'));
    // The initial snapshot is written BEFORE fs.watch is registered. Mutating in
    // that window means the change is never observed, and no deadline rescues a
    // missed event — wait for the watcher to announce itself first.
    await waitFor(() => /Watching items\.jsonl and events\.jsonl/.test(watcher.output()));
    store.writeItems([item(), item({ id: 'P1-02', title: 'Watch this board' })]);
    await waitFor(() => readFileSync(store.paths.board, 'utf8').includes('Watch this board'));
    await waitFor(() => /P1-02 added/.test(watcher.output()));
    const startup = watcher.output();
    assert.ok(startup.indexOf('Watching') < startup.indexOf('P1-02 added'));
    assert.equal(startup.slice(0, startup.indexOf('Watching')).includes('· 1 item'), false);
    assert.match(watcher.output(), /\d{4}-\d\d-\d\dT.*· 2 items · P1-02 added/);
  } finally {
    await stopWatcher(watcher.child);
  }
});

test('gw open --watch debounces rapid changes', async () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const watcher = startWatcher(root);
  try {
    await waitFor(() => existsSync(store.paths.board) && readFileSync(store.paths.board, 'utf8').includes('Repo scaffold'));
    // Wait until the watcher is registered: the initial snapshot is written
    // before fs.watch exists, and a change made in that window is never seen.
    await waitFor(() => /Watching items\.jsonl and events\.jsonl/.test(watcher.output()));
    for (let i = 0; i < 5; i += 1) store.writeItems([item({ title: `Rapid ${i}` })]);
    await waitFor(() => readFileSync(store.paths.board, 'utf8').includes('Rapid 4'));
    await waitFor(() => /\d{4}-\d\d-\d\dT.*· \d+ items? · /.test(watcher.output()));
    const rebuilds = (watcher.output().match(/\d{4}-\d\d-\d\dT.*· \d+ items? · /g) ?? []).length;
    assert.ok(rebuilds >= 1);
    assert.ok(rebuilds < 5, `expected fewer rebuilds than writes, got ${rebuilds}`);
  } finally {
    await stopWatcher(watcher.child);
  }
});

test('gw open --watch summarizes a stage move', async () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const watcher = startWatcher(root);
  try {
    await waitFor(() => existsSync(store.paths.board) && readFileSync(store.paths.board, 'utf8').includes('Repo scaffold'));
    // Wait until the watcher is registered: the initial snapshot is written
    // before fs.watch exists, and a change made in that window is never seen.
    await waitFor(() => /Watching items\.jsonl and events\.jsonl/.test(watcher.output()));
    const moved = item({ stage: 'decided' });
    store.writeItems([moved]);
    await waitFor(() => /P1-01 → decided/.test(watcher.output()));
  } finally {
    await stopWatcher(watcher.child);
  }
});

test('gw open --watch keeps the last good board when JSONL is corrupt', async () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const watcher = startWatcher(root);
  try {
    await waitFor(() => existsSync(store.paths.board) && readFileSync(store.paths.board, 'utf8').includes('Repo scaffold'));
    // Wait until the watcher is registered: the initial snapshot is written
    // before fs.watch exists, and a change made in that window is never seen.
    await waitFor(() => /Watching items\.jsonl and events\.jsonl/.test(watcher.output()));
    const before = readFileSync(store.paths.board, 'utf8');
    writeFileSync(store.paths.items, '{corrupt\n');
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(readFileSync(store.paths.board, 'utf8'), before);
    assert.equal(watcher.child.exitCode, null, `watcher died (code ${watcher.child.exitCode}); its stderr was:\n${watcher.errors()}`);
  } finally {
    await stopWatcher(watcher.child);
  }
});
