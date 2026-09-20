import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, partitionEvents, writeAtomic } from '../lib/store.js';

function board(prefix = 'gw-durability-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = createStore(root);
  store.ensure();
  return { root, store };
}

// T-0136 — a rename is only atomic with respect to what the filesystem has
// actually persisted. Without the fsync the tmp file's CONTENT can still be in
// the page cache when the rename lands, so a crash leaves a present-but-empty
// items.jsonl: worse than either the old file or the new one.
test('writeAtomic fsyncs the temp file before the rename, and the directory after it', () => {
  const { root } = board('gw-durability-atomic-');
  const path = join(root, '.gatewright', 'items.jsonl');
  const calls = [];
  let renamed = false;
  writeAtomic(path, 'one line\n', {
    rename: (from, to) => { renamed = true; calls.push('rename'); renameSync(from, to); },
    fsync: () => { calls.push(renamed ? 'fsync:dir' : 'fsync:file'); },
  });
  assert.deepEqual(calls, ['fsync:file', 'rename', 'fsync:dir']);
  assert.equal(readFileSync(path, 'utf8'), 'one line\n');
});

// Windows (and some network filesystems) refuse to open a directory for
// fsync at all. The data is already renamed into place by then, so a refusal
// there must never fail the command.
test('a directory fsync the platform refuses does not fail the write', () => {
  const { root } = board('gw-durability-windows-');
  const path = join(root, '.gatewright', 'items.jsonl');
  let renamed = false;
  writeAtomic(path, 'still written\n', {
    rename: (from, to) => { renamed = true; renameSync(from, to); },
    fsync: () => {
      if (!renamed) return;
      const error = new Error('EPERM: operation not permitted, fsync');
      error.code = 'EPERM';
      throw error;
    },
  });
  assert.equal(readFileSync(path, 'utf8'), 'still written\n');
  assert.deepEqual(readdirSync(join(root, '.gatewright')).filter((name) => name.endsWith('.tmp')), [], 'no temp file is left behind');
});

test('appendEvent fsyncs the event log it just appended to', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-durability-append-'));
  const calls = [];
  const store = createStore(root, { fsync: () => calls.push('fsync') });
  store.ensure();
  store.appendEvent({ type: 'add', item: 'T-1', by: 'human:test' });
  assert.ok(calls.length >= 1, 'the appended event must be fsynced before appendEvent returns');
  assert.equal(store.readEvents().length, 1);
});

test('partitionEvents keeps every event of an open item and the tail of a terminal one', () => {
  const events = [
    ...Array.from({ length: 30 }, (_, i) => ({ ts: `t${i}`, type: 'note', item: 'OPEN-1' })),
    ...Array.from({ length: 30 }, (_, i) => ({ ts: `t${i}`, type: 'note', item: 'DONE-1', n: i })),
  ];
  const { kept, archived } = partitionEvents(events, { open: new Set(['OPEN-1']), keep: 5 });
  assert.equal(kept.filter((e) => e.item === 'OPEN-1').length, 30);
  assert.deepEqual(kept.filter((e) => e.item === 'DONE-1').map((e) => e.n), [25, 26, 27, 28, 29]);
  assert.equal(archived.length, 25);
  assert.equal(kept.length + archived.length, events.length);
});

test('partitionEvents preserves file order and caps board-level events that name no item', () => {
  const events = [
    { ts: 't0', type: 'sync' },
    { ts: 't1', type: 'note', item: 'OPEN-1' },
    { ts: 't2', type: 'sync' },
    { ts: 't3', type: 'note', item: 'DONE-1' },
  ];
  const { kept, archived } = partitionEvents(events, { open: new Set(['OPEN-1']), keep: 1 });
  assert.deepEqual(kept.map((e) => e.ts), ['t1', 't2', 't3']);
  assert.deepEqual(archived.map((e) => e.ts), ['t0']);
});

// An item that was deleted from items.jsonl is not open, so its events are
// audit trail: the alternative is a bucket that can never be compacted.
test('partitionEvents treats events for unknown items as terminal', () => {
  const events = Array.from({ length: 4 }, (_, i) => ({ ts: `t${i}`, type: 'note', item: 'GONE-9' }));
  const { kept, archived } = partitionEvents(events, { open: new Set(), keep: 2 });
  assert.deepEqual(kept.map((e) => e.ts), ['t2', 't3']);
  assert.equal(archived.length, 2);
});
