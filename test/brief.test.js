import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { run as runBrief } from '../lib/commands/brief.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
import { renderBrief } from '../lib/brief.js';
import { makeItems, makeEvents } from './fixtures/make-items.js';

const stages = { stages: [
  { id: 'backlog' }, { id: 'specified' }, { id: 'building', label: 'Building', requires: { owner: true } },
  { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review' }, { id: 'reviewed' }, { id: 'merged' }, { id: 'verified' },
], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };

test('brief reproduces the fixed section order and filters dispatches by owner', () => {
  const items = makeItems(8);
  items[0] = { ...items[0], id: 'P2-01', stage: 'specified', owner: null, flag: null };
  items[1] = { ...items[1], id: 'P2-02', stage: 'in_review', deps: ['P2-01'] };
  const out = renderBrief({ items, events: [{ type: 'dispatch', item: 'P2-01', by: 'human:rahil' }], stages, config: { brief: { max_lines: 25 } }, git: { branch: 'main', sha: '895e249' } }, { me: 'human:rahil' });
  assert.match(out, /^gw · /);
  assert.ok(out.indexOf('DISPATCHED TO YOU') < out.indexOf('IN FLIGHT'));
  assert.ok(out.indexOf('IN FLIGHT') < out.indexOf('BLOCKED'));
  assert.ok(out.endsWith('`gw move` needs evidence past Building. Never edit .gatewright/ by hand.\n'));
  assert.match(out, /P2-01.*specified → building/);
});

test('brief footer derives the stage before the first evidence gate', () => {
  const foreignStages = {
    stages: [
      { id: 'icebox', label: 'Icebox' },
      { id: 'speccing', label: 'Speccing' },
      { id: 'coding', label: 'Coding' },
      { id: 'shipped', label: 'Shipped', requires: { evidence_min: 1 } },
    ],
  };
  const out = renderBrief({ items: [], events: [], stages: foreignStages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /`gw move` needs evidence past Coding\. Never edit/);
});

test('brief title-cases an unlabelled stage id in its footer', () => {
  const out = renderBrief({
    items: [], events: [],
    stages: { stages: [{ id: 'icebox' }, { id: 'coding' }, { id: 'shipped', requires: { evidence_min: 1 } }] },
    config: { brief: { max_lines: 25 } },
  });
  assert.match(out, /`gw move` needs evidence past Coding\. Never edit/);
});

test('brief footer is neutral when no pipeline stage requires evidence', () => {
  const out = renderBrief({ items: [], events: [], stages: { stages: [{ id: 'icebox' }, { id: 'shipped' }] }, config: { brief: { max_lines: 25 } } });
  assert.match(out, /`gw move` needs evidence where the stage requires it\. Never edit/);
});

test('100-item brief stays within the agent token and line budget and keeps dispatch visible', () => {
  const items = makeItems(100);
  const out = renderBrief({ items, events: makeEvents(items), stages, config: { brief: { max_lines: 25 } }, git: null });
  const lines = out.trimEnd().split('\n');
  assert.ok(lines.length <= 25, `got ${lines.length} lines`);
  assert.ok(Math.ceil(out.length / 4) <= 500, `got ${Math.ceil(out.length / 4)} approximate tokens`);
  assert.match(out, /DISPATCHED TO YOU/);
});

test('empty board produces a helpful brief', () => {
  const out = renderBrief({ items: [], events: [], stages, config: { brief: { max_lines: 25 } }, git: null });
  assert.match(out, /No open work/);
  assert.match(out, /Rules:/);
  assert.ok(out.split('\n').length < 10);
});

test('brief does not treat a stage as dropped when the pipeline has no dropped role', () => {
  const foreignStages = { stages: [{ id: 'icebox' }, { id: 'shipped' }], terminal: ['shipped'], extra: [] };
  const out = renderBrief({ items: [{ ...makeItems(1)[0], stage: 'binned', flag: null }], events: [], stages: foreignStages, config: { brief: { max_lines: 25 } }, git: null });
  assert.match(out, /^gw · 1 open/m);
});

test('brief is read-only byte-for-byte', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-')); const store = createStore(root); store.ensure();
  const items = makeItems(2); store.writeItems(items); writeFileSync(store.paths.events, `${JSON.stringify({ type: 'dispatch', item: items[0].id, by: 'scheduler' })}\n`);
  const before = [store.paths.items, store.paths.events, store.paths.digest].map((path) => readFileSync(path)); let out = '';
  runBrief({ store, root, flags: {}, stdout: { write: (value) => { out += value; } } });
  assert.ok(out); assert.deepEqual([store.paths.items, store.paths.events, store.paths.digest].map((path) => readFileSync(path)), before);
});

test('brief works through the real binary', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-bin-')); const store = createStore(root); store.ensure(); store.writeItems(makeItems(1));
  assert.match(execFileSync(process.execPath, [BIN, 'brief'], { cwd: root, encoding: 'utf8' }), /^gw · 1 open/m);
});

test('budget priority differs from printed order: every populated section gets a fair floor', () => {
  const items = makeItems(100);
  items[0] = { ...items[0], stage: 'specified', owner: null, flag: null, deps: [] };
  items[1] = { ...items[1], stage: 'backlog', owner: null, flag: 'blocked', deps: [] };
  items[2] = { ...items[2], stage: 'building', owner: 'agent:r-0001', flag: null, deps: [] };
  items[3] = { ...items[3], stage: 'backlog', owner: null, flag: 'needs-triage', deps: [] };
  items[4] = { ...items[4], stage: 'backlog', owner: null, flag: null, deps: [] };
  const out = renderBrief({ items, events: [0, 5, 6].map((index) => ({ type: 'dispatch', item: items[index].id, by: 'scheduler' })), stages, config: { brief: { max_lines: 25 } }, git: { branch: 'main', sha: '895e249' } });
  for (const heading of ['DISPATCHED TO YOU', 'IN FLIGHT', 'BLOCKED', 'NEEDS TRIAGE', 'NEXT UNBLOCKED']) assert.match(out, new RegExp(heading));
  assert.ok(out.trimEnd().split('\n').length <= 25);
  assert.ok(Math.ceil(out.length / 4) <= 500);
  assert.ok(out.indexOf('DISPATCHED TO YOU') < out.indexOf('IN FLIGHT'));
  assert.ok(out.indexOf('IN FLIGHT') < out.indexOf('BLOCKED'));
  assert.ok(out.indexOf('BLOCKED') < out.indexOf('NEEDS TRIAGE'));
  assert.ok(out.indexOf('NEEDS TRIAGE') < out.indexOf('NEXT UNBLOCKED'));
  const dispatchedBlock = out.split('DISPATCHED TO YOU')[1].split('\n\n')[0];
  const shown = dispatchedBlock.split('\n').filter((line) => /^  [A-Z]\S*/.test(line)).length;
  const total = 3;
  assert.match(out, new RegExp(`\\(\\+${total - shown} more\\)`));
});

test('a tiny budget preserves DISPATCHED TO YOU even when lower-priority sections are dropped', () => {
  const items = makeItems(5).map((item, index) => ({ ...item, stage: index === 0 ? 'specified' : 'backlog', owner: null, flag: null, deps: [] }));
  const out = renderBrief({ items, events: [{ type: 'dispatch', item: items[0].id, by: 'scheduler' }], stages, config: { brief: { max_lines: 12 } }, git: null });
  assert.match(out, /DISPATCHED TO YOU/);
  assert.ok(out.trimEnd().split('\n').length <= 12);
});

test('in-flight rows align stage and owner columns and use unowned instead of null', () => {
  const items = [
    { ...makeItems(1)[0], id: 'A', stage: 'specified', owner: 'agent:a', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'B', stage: 'built', owner: null, flag: null, deps: [] },
  ];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } }, git: null });
  const rows = out.split('\n').filter((line) => line.includes('agent:a') || line.includes('unowned'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((line) => !line.includes('null')));
  assert.equal(rows[0].indexOf('agent:a'), rows[1].indexOf('unowned'));
});

test('fixture titles vary in length for truncation and alignment coverage', () => {
  const titles = makeItems(20).map((item) => item.title);
  assert.ok(new Set(titles).size > 3);
  assert.ok(titles.some((value) => value.length < 30));
  assert.ok(titles.some((value) => value.length > 80));
});
