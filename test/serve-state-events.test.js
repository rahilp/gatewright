import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';

// /api/state's FIRST load used to inline the entire event log. ?since has always
// capped the incremental polls, but a full page reload sends no `since`, so a
// year-old board answered every reload with its whole history -- 13MB+ at the
// audited 2,000-item/100k-event scale, synchronously serialised on the same
// thread the scheduler ticks on.
//
// The split is the one `gw open` and `gw gc --events` already make, from the
// same helper: every event of an open item, the tail of each finished one. That
// is what keeps a snapshot, a compacted board and the live board from
// disagreeing about which history is hot.

const STAGES = { stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'built', requires: { evidence_min: 1 } }], terminal: ['built'], extra: [] };

function item(id, stage) {
  return { id, title: id, phase: 'P1', priority: 'P1', gate: 'G0', type: 'feature', stage, flag: null, owner: null, scope: '', deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' };
}

// events.jsonl is written directly: appendEvent re-baselines the digest per
// call, and this fixture is about the shape of a long log, not about the digest.
function note(id, index) {
  return { ts: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, type: 'note', item: id, by: 'human', text: `n${index}` };
}

async function withBoard(fn, { config = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-serve-events-'));
  const store = createStore(root); store.ensure();
  store.writeItems([item('P1-01', 'backlog'), item('P1-02', 'built')]);
  writeFileSync(store.paths.stages, JSON.stringify(STAGES));
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'], gate: ['G0'] }, ...config }));
  store.rebaselineDigest();
  const server = createServeServer({ store });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${address.port}`;
  try { await fn({ store, url, state: async (query = '') => (await fetch(`${url}/api/state${query}`)).json() }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

function writeLog(store, lines) {
  writeFileSync(store.paths.events, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

test('a first load keeps every event of an open item and only the tail of a finished one', async () => {
  await withBoard(async ({ store, state }) => {
    const open = Array.from({ length: 30 }, (_, index) => note('P1-01', index));
    const done = Array.from({ length: 30 }, (_, index) => note('P1-02', index));
    writeLog(store, [...open, ...done]);

    const body = await state();
    const forOpen = body.events.filter((event) => event.item === 'P1-01');
    const forDone = body.events.filter((event) => event.item === 'P1-02');
    assert.equal(forOpen.length, 30, 'an open item is the history someone is working with: all of it stays');
    assert.equal(forDone.length, 20, 'a finished item keeps the default gc.events_keep tail');
    assert.deepEqual(forDone.map((event) => event.text), done.slice(-20).map((event) => event.text), 'and it is the LAST twenty, in order');
    assert.equal(body.config.eventsOmitted, 10, 'the response has to say how much history it is not carrying');
    assert.equal(body.config.eventsArchive, 'events-archive.jsonl', 'and where the rest of it lives');
  });
});

// A board that has nothing to omit must answer exactly what it always answered:
// a viewer that predates these keys sees no change at all.
test('a board with a short log carries no omission keys', async () => {
  await withBoard(async ({ store, state }) => {
    writeLog(store, [note('P1-01', 0), note('P1-02', 1)]);
    const body = await state();
    assert.equal(body.events.length, 2);
    assert.ok(!('eventsOmitted' in body.config), 'nothing was left out, so nothing is claimed');
    assert.ok(!('eventsArchive' in body.config));
  });
});

test('gc.events_keep decides the tail, so the live board and a compacted board agree', async () => {
  await withBoard(async ({ store, state }) => {
    writeLog(store, Array.from({ length: 25 }, (_, index) => note('P1-02', index)));
    const body = await state();
    assert.equal(body.events.length, 5, 'the setting the board is configured with, not a serve-private constant');
    assert.equal(body.config.eventsOmitted, 20);
  }, { config: { gc: { events_keep: 5 } } });
});

// ?since is the incremental poll and is deliberately untouched: it already
// carries only what is new, the viewer appends it to what it holds, and capping
// it would silently drop events the board would then never see.
test('?since returns exactly the newer events and claims no omission', async () => {
  await withBoard(async ({ store, state }) => {
    const done = Array.from({ length: 30 }, (_, index) => note('P1-02', index));
    writeLog(store, done);
    const body = await state('?since=2026-01-01T00%3A00%3A27.000Z');
    assert.deepEqual(body.events.map((event) => event.text), ['n28', 'n29'], 'every event newer than the cursor, capped or not');
    assert.ok(!('eventsOmitted' in body.config), 'an incremental poll omits nothing: it was never carrying the history');
  });
});

test('a first load still carries the board-level events a poll would need', async () => {
  await withBoard(async ({ store, state }) => {
    writeLog(store, [
      ...Array.from({ length: 30 }, (_, index) => note('P1-02', index)),
      { ts: '2026-01-01T00:01:00.000Z', type: 'dispatch', item: 'P1-01', by: 'human' },
    ]);
    const body = await state();
    assert.ok(body.events.some((event) => event.type === 'dispatch' && event.item === 'P1-01'), 'a live dispatch on an open item drives the board\'s Play/Cancel control and must never be capped away');
  });
});
