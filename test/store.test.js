import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';

function freshStore() {
  const root = mkdtempSync(join(tmpdir(), 'gw-'));
  const store = createStore(root);
  store.ensure();
  return store;
}

const item = (over = {}) => ({
  id: 'P1-01', title: 'Repo scaffold', phase: 'P1', priority: 'P1', gate: 'G0',
  type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '',
  deps: [], evidence: [], notes: '', refs: [], parent: null,
  created_by: 'human', gh: null,
  created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z', ...over,
});

test('ensure() creates the data files, and reading an empty board gives an empty list', () => {
  const store = freshStore();
  assert.deepEqual(store.readItems(), []);
  assert.deepEqual(store.readEvents(), []);
});

test('items round-trip through writeItems/readItems', () => {
  const store = freshStore();
  store.writeItems([item(), item({ id: 'P1-02', title: 'store.js' })]);
  const read = store.readItems();
  assert.equal(read.length, 2);
  assert.deepEqual(read[0], item());
  assert.equal(read[1].id, 'P1-02');
});

test('items.jsonl is one item per line so a one-item change is a one-line diff', () => {
  const store = freshStore();
  store.writeItems([item(), item({ id: 'P1-02' })]);
  const raw = readFileSync(store.paths.items, 'utf8');
  const lines = raw.split('\n');
  assert.equal(lines.at(-1), '', 'file ends with a newline');
  assert.equal(lines.length - 1, 2);
  for (const line of lines.slice(0, -1)) assert.doesNotThrow(() => JSON.parse(line));
});

test('a write leaves no temp files behind', () => {
  const store = freshStore();
  store.writeItems([item()]);
  const strays = readdirSync(store.dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(strays, []);
});

test('appendEvent stamps ts and preserves order', () => {
  const store = freshStore();
  store.appendEvent({ type: 'add', item: 'P1-01', by: 'human:rahil' });
  store.appendEvent({ type: 'claim', item: 'P1-01', by: 'human:rahil' });
  const events = store.readEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'add');
  assert.equal(events[1].type, 'claim');
  assert.match(events[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

test('appendEvent never rewrites earlier lines', () => {
  const store = freshStore();
  store.appendEvent({ type: 'add', item: 'P1-01', by: 'human:rahil' });
  const first = readFileSync(store.paths.events, 'utf8');
  store.appendEvent({ type: 'note', item: 'P1-01', by: 'human:rahil', note: 'hi' });
  const second = readFileSync(store.paths.events, 'utf8');
  assert.ok(second.startsWith(first), 'the existing log must be a prefix of the new log');
});

test('a corrupt line in items.jsonl fails loudly with the line number', () => {
  const store = freshStore();
  store.writeItems([item()]);
  writeFileSync(store.paths.items, readFileSync(store.paths.items, 'utf8') + 'not json\n');
  assert.throws(() => store.readItems(), /items\.jsonl.*line 2/s);
});

// --- digest: the "never hand-edit .gatewright/" rule needs enforcement, not just instruction (D6)

test('every write re-baselines the digest, so a clean board verifies clean', () => {
  const store = freshStore();
  store.writeItems([item()]);
  assert.deepEqual(store.verifyDigest(), { status: 'clean' });
});

test('the digest records the hash and when it was written', () => {
  const store = freshStore();
  store.writeItems([item()]);
  const digest = JSON.parse(readFileSync(store.paths.digest, 'utf8'));
  assert.match(digest.items, /^[0-9a-f]{64}$/);
  assert.match(digest.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('an edit made outside gw is detected, and reported with the time of the last gw write', () => {
  const store = freshStore();
  store.writeItems([item()]);
  const writtenAt = JSON.parse(readFileSync(store.paths.digest, 'utf8')).ts;

  writeFileSync(store.paths.items, JSON.stringify(item({ stage: 'verified' })) + '\n');

  const result = store.verifyDigest();
  assert.equal(result.status, 'modified');
  assert.equal(result.since, writtenAt);
});

test('re-baselining reports an out-of-band edit once, not on every run', () => {
  const store = freshStore();
  store.writeItems([item()]);
  writeFileSync(store.paths.items, JSON.stringify(item({ stage: 'verified' })) + '\n');

  assert.equal(store.verifyDigest().status, 'modified');
  store.rebaselineDigest();
  assert.equal(store.verifyDigest().status, 'clean');
});

test('a missing digest is unknown, not an accusation', () => {
  const store = freshStore();
  store.writeItems([item()]);
  rmSync(store.paths.digest);
  assert.deepEqual(store.verifyDigest(), { status: 'unknown' });
});

// --- locking: two agent runs and a human at a terminal can all write at once

test('withLock returns the body result and releases the lock', () => {
  const store = freshStore();
  const result = store.withLock(() => 'done');
  assert.equal(result, 'done');
  assert.equal(existsSync(store.paths.lock), false);
});

test('the lock is released even when the body throws', () => {
  const store = freshStore();
  assert.throws(() => store.withLock(() => { throw new Error('boom'); }), /boom/);
  assert.equal(existsSync(store.paths.lock), false);
});

test('a lock held by a live process is waited for, then given up on with a clear error', () => {
  const store = freshStore();
  writeFileSync(store.paths.lock, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  assert.throws(
    () => store.withLock(() => 'never runs', { giveUpMs: 150, pollMs: 10 }),
    /lock.*another gw process/i,
  );
});

test('a lock left behind by a dead process is broken, not waited on forever', () => {
  const store = freshStore();
  const deadPid = 0x7fffffff; // outside any plausible pid range
  writeFileSync(store.paths.lock, JSON.stringify({ pid: deadPid, ts: new Date().toISOString() }));
  assert.equal(store.withLock(() => 'ran', { giveUpMs: 500, pollMs: 10 }), 'ran');
});

test('paths cover every on-disk file, including the prompt template', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-'));
  const store = createStore(root);
  assert.equal(store.paths.prompt, join(root, '.gatewright', 'prompt.md'));
});

test('concurrent read-modify-writes from separate processes lose nothing', async () => {
  const store = freshStore();
  const worker = fileURLToPath(new URL('./fixtures/claim-worker.mjs', import.meta.url));
  const ids = Array.from({ length: 8 }, (_, i) => `P1-${String(i + 1).padStart(2, '0')}`);

  await Promise.all(ids.map((id) => new Promise((resolve, reject) => {
    execFile(process.execPath, [worker, store.root, id], { env: { ...process.env, GW_TEST_LOCK_GIVEUP_MS: '60000' } }, (err) => (err ? reject(err) : resolve()));
  })));

  assert.deepEqual(store.readItems().map((i) => i.id).sort(), [...ids].sort());
  assert.equal(store.readEvents().length, 8);
  assert.equal(store.verifyDigest().status, 'clean');
});

test('writeConfig atomically round-trips valid JSON without leaving a temp file', () => {
  const store = freshStore();
  const config = { version: 1, github: { last_sync: '2026-09-14T12:00:00Z' } };
  store.writeItems([item()]);
  const digestBefore = readFileSync(store.paths.digest, 'utf8');
  store.writeConfig(config);
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')), config);
  assert.equal(readFileSync(store.paths.digest, 'utf8'), digestBefore, 'config writes must not rebaseline the items digest');
  assert.deepEqual(readdirSync(store.dir).filter((file) => file.includes('.tmp')), []);
});
