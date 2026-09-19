import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { IOError } from '../lib/cli/errors.js';

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

test('atomic writes retry transient Windows rename failures and complete', () => {
  let attempts = 0;
  const store = createStore(mkdtempSync(join(tmpdir(), 'gw-')), {
    rename(from, to) {
      attempts += 1;
      if (attempts <= 3) {
        const error = new Error('file is in use');
        error.code = 'EPERM';
        throw error;
      }
      return renameSync(from, to);
    },
  });
  store.ensure();

  store.writeItems([item()]);

  assert.equal(attempts, 5, 'three retries for items, then items and digest succeed');
  assert.deepEqual(store.readItems(), [item()]);
});

test('atomic writes explain a persistently held Windows file and preserve its cause', () => {
  let attempts = 0;
  const heldOpen = new Error('file is in use');
  heldOpen.code = 'EBUSY';
  const store = createStore(mkdtempSync(join(tmpdir(), 'gw-')), {
    rename() {
      attempts += 1;
      throw heldOpen;
    },
  });
  store.ensure();

  assert.throws(
    () => store.writeItems([item()]),
    (error) => error instanceof IOError
      && error.exitCode === 3
      && /held open by another process/i.test(error.message)
      && /gw serve.*gw open --watch/i.test(error.message)
      && error.cause === heldOpen,
  );
  assert.equal(attempts, 6, 'initial attempt plus five bounded retries');
});

test('atomic writes do not retry non-transient rename failures', () => {
  let attempts = 0;
  const failure = new Error('invalid path');
  failure.code = 'EINVAL';
  const store = createStore(mkdtempSync(join(tmpdir(), 'gw-')), {
    rename() {
      attempts += 1;
      throw failure;
    },
  });
  store.ensure();

  assert.throws(() => store.writeItems([item()]), (error) => error === failure);
  assert.equal(attempts, 1);
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

// stages.json and config.json define the gates, so a hand edit to either is
// exactly the tampering the digest exists to catch (T-0002).
test('a hand edit to stages.json is detected and named, not just items.jsonl', () => {
  const store = freshStore();
  store.writeItems([item()]);
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }], terminal: [], extra: [] }));
  const result = store.verifyDigest();
  assert.equal(result.status, 'modified');
  assert.deepEqual(result.files, ['stages.json']);
});

test('a hand edit to config.json is detected and named', () => {
  const store = freshStore();
  store.writeItems([item()]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1 }));
  const result = store.verifyDigest();
  assert.equal(result.status, 'modified');
  assert.deepEqual(result.files, ['config.json']);
});

test('a hand edit to both files is reported one line per file', () => {
  const store = freshStore();
  store.writeItems([item()]);
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }], terminal: [], extra: [] }));
  writeFileSync(store.paths.config, JSON.stringify({ version: 1 }));
  const result = store.verifyDigest();
  assert.deepEqual(result.files, ['stages.json', 'config.json']);
});

// events.jsonl is append-only: adding a line is normal operation, never
// tampering, so it is deliberately not digested.
test('appending to events.jsonl is not reported', () => {
  const store = freshStore();
  store.writeItems([item()]);
  store.appendEvent({ type: 'note', item: 'P1-01', by: 'human:rahil' });
  assert.deepEqual(store.verifyDigest(), { status: 'clean' });
});

// A .digest written before stages.json and config.json were protected has only
// the `items` key. Missing hashes mean unknown, baseline silently — otherwise
// every upgraded board screams on its first check.
test('an old-format digest (items key only) is unknown and baselines silently', () => {
  const store = freshStore();
  store.writeItems([item()]);
  const itemsHash = createHash('sha256').update(readFileSync(store.paths.items)).digest('hex');
  writeFileSync(store.paths.digest, JSON.stringify({ items: itemsHash, ts: '2026-09-01T00:00:00.000Z' }) + '\n');
  assert.deepEqual(store.verifyDigest(), { status: 'unknown' });
  store.rebaselineDigest();
  assert.deepEqual(store.verifyDigest(), { status: 'clean' });
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
  store.writeConfig(config);
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')), config);
  // config.json is digested too, so a legitimate write must re-baseline it:
  // a `gw config` that made the next check cry tampering would make the
  // report useless.
  assert.equal(store.verifyDigest().status, 'clean');
  assert.deepEqual(readdirSync(store.dir).filter((file) => file.includes('.tmp')), []);
});

// T-0029 — the on-disk evidence shape changed: each entry carries the stage
// whose move supplied it. Existing boards carry flat strings. Reads normalise
// in memory (an old board works at once); the next gw write persists the new
// shape and re-baselines the digest with it, so an upgrade is never reported
// as an out-of-band write by the tool that just performed it.
test('legacy flat-string evidence reads as stage-null entries and migrates on the next write', () => {
  const store = freshStore();
  writeFileSync(store.paths.items, JSON.stringify(item({ stage: 'built', evidence: ['abc123', 'https://github.com/a/b/pull/1'] })) + '\n');
  store.rebaselineDigest();
  assert.equal(store.verifyDigest().status, 'clean', 'reading the old shape changes nothing on disk');

  const read = store.readItems()[0];
  assert.deepEqual(read.evidence, [
    { text: 'abc123', stage: null },
    { text: 'https://github.com/a/b/pull/1', stage: null },
  ]);

  store.writeItems([read]);
  const persisted = JSON.parse(readFileSync(store.paths.items, 'utf8').trim());
  assert.deepEqual(persisted.evidence, read.evidence, 'the first write persists the migrated shape');
  assert.equal(store.verifyDigest().status, 'clean', 'the migrated write re-baselines its own digest');
  // invalid entries (neither a string nor a {text, stage} object) are dropped
  // rather than crashing a read
  writeFileSync(store.paths.items, JSON.stringify(item({ evidence: ['ok', 42, { text: 'kept' }, { text: 7 }], stage: 'built' })) + '\n');
  assert.deepEqual(store.readItems()[0].evidence, [{ text: 'ok', stage: null }, { text: 'kept', stage: null }]);
});

test('an upgraded board never reports its own migration as an out-of-band write', async () => {
  const store = freshStore();
  writeFileSync(store.paths.items, JSON.stringify(item({ stage: 'backlog', evidence: ['abc123'] })) + '\n');
  store.rebaselineDigest();
  const bin = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [bin, ...args], { cwd: store.root, encoding: 'utf8' }, (err, stdout) => resolve({ err, stdout })));
  for (const args of [['check'], ['config', 'id_scheme']]) {
    const { err, stdout } = await run(args);
    assert.equal(err?.code ?? 0, 0, `${args.join(' ')} exits clean`);
    assert.doesNotMatch(stdout, /modified outside gw/, `gw ${args[0]} must not accuse the migration of tampering`);
  }
});

// T-0049 — a read-only board directory used to surface
// "EACCES: permission denied, open '.../.lock.<pid>.tmp'": exit code 3 was
// right, but the message named a temp file the user never created and never
// said the directory was the problem.
test('a read-only board directory explains itself instead of naming a temp file', { skip: process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0) ? 'chmod cannot block a root user and is a no-op on Windows' : false }, () => {
  const store = freshStore();
  chmodSync(store.dir, 0o555);
  try {
    assert.throws(
      () => store.withLock(() => 'never runs'),
      (error) => error instanceof IOError
        && error.exitCode === 3
        && /is not writable \(permission denied\)/.test(error.message)
        && !/\.lock\.\d+\.tmp/.test(error.message),
      'the message must say the directory is not writable, not name a temp file',
    );
  } finally {
    chmodSync(store.dir, 0o755);
  }
});
