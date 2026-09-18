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
import { renderBrief, inFlightTitles, sanitizeTitle, isFlagged, flaggedItems, outstandingDispatches, briefJson } from '../lib/brief.js';
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
  assert.ok(out.endsWith("Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate. Never edit .gatewright/ by hand.\n"));
  assert.match(out, /P2-01.*specified → building/);
});

// P0-15 removed the item field `gate`, with no migration path. An item
// loaded from disk that still carries a legacy `gate` key must not disturb
// brief in any way: NEXT UNBLOCKED shows phase alone, with no trace of it.
test('brief tolerates a legacy gate key on disk and shows phase alone in NEXT UNBLOCKED', () => {
  const legacy = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: [], phase: 'P1', gate: 'G0' };
  const out = renderBrief({ items: [legacy], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /NEXT UNBLOCKED[\s\S]*P1-01[\s\S]* P1$/m);
  assert.equal(out.includes('G0'), false, 'a legacy gate value must never surface in the digest');
});

test('brief shows each parent its open child count', () => {
  const parent = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', flag: null, deps: [] };
  const child = { ...makeItems(1)[0], id: 'P1-01.1', parent: 'P1-01', stage: 'backlog', flag: null, deps: [] };
  const out = renderBrief({ items: [parent, child], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /P1-01.*1 open child/);
});

test('brief footer states the conditional evidence rule on a foreign pipeline (T-0038)', () => {
  const foreignStages = {
    stages: [
      { id: 'icebox', label: 'Icebox' },
      { id: 'speccing', label: 'Speccing' },
      { id: 'coding', label: 'Coding' },
      { id: 'shipped', label: 'Shipped', requires: { evidence_min: 1 } },
    ],
  };
  const out = renderBrief({ items: [], events: [], stages: foreignStages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate\. Never edit/);
  assert.doesNotMatch(out, /needs evidence past/, 'the footer must not name a stage: non-contiguous evidence gates made that a lie');
});

test('brief footer names no stage even with unlabelled stage ids (T-0038)', () => {
  const out = renderBrief({
    items: [], events: [],
    stages: { stages: [{ id: 'icebox' }, { id: 'coding' }, { id: 'shipped', requires: { evidence_min: 1 } }] },
    config: { brief: { max_lines: 25 } },
  });
  assert.match(out, /Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate\. Never edit/);
});

test('brief footer is the same conditional rule when no pipeline stage requires evidence (T-0038)', () => {
  const out = renderBrief({ items: [], events: [], stages: { stages: [{ id: 'icebox' }, { id: 'shipped' }] }, config: { brief: { max_lines: 25 } } });
  assert.match(out, /Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate\. Never edit/);
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

// T-0012 — a board whose every item reached a terminal stage used to print
// exactly what an untouched board prints, telling a team that just shipped
// everything that nothing was ever here.
test('a finished board is acknowledged, not confused with an empty one', () => {
  const finished = renderBrief({
    items: [
      { ...makeItems(1)[0], id: 'P1-01', title: 'Shipped one', stage: 'verified', flag: null, deps: [] },
      { ...makeItems(1)[0], id: 'P1-02', title: 'Dropped one', stage: 'dropped', flag: null, deps: [] },
    ],
    events: [], stages, config: { brief: { max_lines: 25 } }, git: null,
  });
  assert.equal(
    finished.includes('All 2 item(s) are finished. Start new work with `gw add "title"`.'),
    true,
    `expected the finished-board line, got:\n${finished}`,
  );
  assert.equal(finished.includes('No open work'), false, 'a finished board must not read as an untouched one');
  // The empty board keeps its own line; the two are not the same sentence.
  const empty = renderBrief({ items: [], events: [], stages, config: { brief: { max_lines: 25 } }, git: null });
  const emptyLine = 'No open work. Add one with `gw add "title"`.';
  assert.equal(empty.includes(emptyLine), true);
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

// T-0069 — a bare `--me` must parse (it used to die with "flag --me needs a
// value") and mean the resolved actor: GW_ACTOR here.
test('T-0069: a bare --me parses and means the GW_ACTOR', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-me-bin-')); const store = createStore(root); store.ensure();
  store.writeItems([
    { ...makeItems(1)[0], id: 'P1-01', title: 'Mine', stage: 'building', owner: 'agent:me', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-02', title: 'Theirs', stage: 'building', owner: 'agent:other', flag: null, deps: [] },
  ]);
  const out = execFileSync(process.execPath, [BIN, 'brief', '--me'], { cwd: root, encoding: 'utf8', env: { ...process.env, GW_ACTOR: 'agent:me' } });
  assert.match(out, /^gw · 1 open · 1 in flight/m);
  assert.match(out, /P1-01/);
  assert.equal(out.includes('P1-02'), false);
  // --me= means the same thing.
  const equals = execFileSync(process.execPath, [BIN, 'brief', '--me='], { cwd: root, encoding: 'utf8', env: { ...process.env, GW_ACTOR: 'agent:me' } });
  assert.equal(equals, out);
});

test('budget priority differs from printed order: actionable sections get a fair floor', () => {
  const items = makeItems(100);
  items[0] = { ...items[0], stage: 'specified', owner: null, flag: null, deps: [] };
  items[1] = { ...items[1], stage: 'backlog', owner: null, flag: 'blocked', deps: [] };
  items[2] = { ...items[2], stage: 'building', owner: 'agent:r-0001', flag: null, deps: [] };
  items[3] = { ...items[3], stage: 'backlog', owner: null, flag: 'needs-triage', deps: [] };
  items[4] = { ...items[4], stage: 'backlog', owner: null, flag: null, deps: [] };
  const out = renderBrief({ items, events: [0, 5, 6].map((index) => ({ type: 'dispatch', item: items[index].id, by: 'scheduler' })), stages, config: { brief: { max_lines: 25 } }, git: { branch: 'main', sha: '895e249' } });
  for (const heading of ['DISPATCHED TO YOU', 'IN FLIGHT', 'STRANDED', 'BLOCKED', 'NEEDS TRIAGE']) assert.match(out, new RegExp(heading));
  assert.doesNotMatch(out, /NEXT UNBLOCKED/, 'a released mid-pipeline item is more actionable than a fresh pick-up when the short brief is full');
  assert.ok(out.trimEnd().split('\n').length <= 25);
  assert.ok(Math.ceil(out.length / 4) <= 500);
  assert.ok(out.indexOf('DISPATCHED TO YOU') < out.indexOf('IN FLIGHT'));
  assert.ok(out.indexOf('IN FLIGHT') < out.indexOf('BLOCKED'));
  assert.ok(out.indexOf('BLOCKED') < out.indexOf('NEEDS TRIAGE'));
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

test('in-flight and stranded rows name their owner state without printing null', () => {
  const items = [
    { ...makeItems(1)[0], id: 'A', stage: 'specified', owner: 'agent:a', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'B', stage: 'built', owner: null, flag: null, deps: [] },
  ];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } }, git: null });
  const rows = out.split('\n').filter((line) => line.includes('agent:a') || line.includes('unowned'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((line) => !line.includes('null')));
});

test('fixture titles vary in length for truncation and alignment coverage', () => {
  const titles = makeItems(20).map((item) => item.title);
  assert.ok(new Set(titles).size > 3);
  assert.ok(titles.some((value) => value.length < 30));
  assert.ok(titles.some((value) => value.length > 80));
});

// P8-24 — claiming an item sets item.owner but never touches its stage, so
// ownership alone used to be read as "in flight". A card sitting untouched in
// backlog with someone's name on it is not in-progress work; it is a promise
// that has not been kept yet, and burying it in IN FLIGHT hid the fact that
// nobody had actually started.
test('P8-24: an item that is claimed but never moved is not reported in flight', () => {
  const claimed = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: 'human:rahil', flag: null, deps: [] };
  const out = renderBrief({ items: [claimed], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /^gw · 1 open · 0 in flight · 0 blocked/m);
  assert.equal(out.includes('IN FLIGHT'), false, 'a claimed-but-unmoved item must not populate IN FLIGHT');
});

test('T-0091: a released item that has moved past its first stage is stranded, not in flight', () => {
  // `gw release` deliberately only clears owner; it must not leave the
  // headline claiming that someone is still working on the card.
  const moved = { ...makeItems(1)[0], id: 'P1-01', stage: 'specified', owner: null, flag: null, deps: [] };
  const out = renderBrief({ items: [moved], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /^gw · 1 open · 0 in flight · 0 blocked/m);
  assert.doesNotMatch(out, /IN FLIGHT/, 'an unowned progressed item must not populate IN FLIGHT');
  assert.match(out, /STRANDED[\s\S]*P1-01/, 'the abandoned item remains visible and actionable');
});

test('P8-24: an owned item is in flight once it has actually moved past its first stage', () => {
  const moved = { ...makeItems(1)[0], id: 'P1-01', stage: 'specified', owner: 'human:rahil', flag: null, deps: [] };
  const out = renderBrief({ items: [moved], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /^gw · 1 open · 1 in flight · 0 blocked/m);
  assert.match(out, /IN FLIGHT[\s\S]*P1-01/);
});

test('P8-24: a claimed item with a live dispatch is in flight even before it has moved', () => {
  // The dispatch is by the scheduler, not by `me` -- otherwise it would land
  // in DISPATCHED TO YOU instead, which is exactly as correct but tests a
  // different section. The point here is that the active dispatch alone (no
  // stage movement yet) is what makes it count as in-flight work.
  const claimed = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: 'human:rahil', flag: null, deps: [] };
  const out = renderBrief({
    items: [claimed],
    events: [{ type: 'dispatch', item: 'P1-01', by: 'scheduler' }],
    stages,
    config: { brief: { max_lines: 25 } },
  }, { me: 'human:rahil' });
  assert.match(out, /^gw · 1 open · 1 in flight · 0 blocked/m);
  assert.match(out, /IN FLIGHT[\s\S]*P1-01/, 'a live run makes an item in flight even while it is still in its first stage');
});

test('T-0091: inFlightTitles agrees with the brief -- claimed-but-unmoved and released work are excluded', () => {
  const claimed = { ...makeItems(1)[0], id: 'P1-01', title: 'Claimed only', stage: 'backlog', owner: 'human:rahil', flag: null, deps: [] };
  const moved = { ...makeItems(1)[0], id: 'P1-02', title: 'Released after moving', stage: 'specified', owner: null, flag: null, deps: [] };
  const titles = inFlightTitles({ items: [claimed, moved], events: [], stages });
  assert.deepEqual(titles, []);
});

// P8-26 — NEXT UNBLOCKED prints a bare phase code ("P1") with nothing to say
// what it means. config.glossary already carries that meaning, and `gw show`
// already reads it via describeTerm; brief did not. A legend line naming
// only the codes actually on screen keeps the digest from growing one
// sentence per row while still answering the question a new agent has the
// first time it sees "P1".
//
// P0-15 removed the item field `gate` (it duplicated priority and no rule
// ever read it), so NEXT UNBLOCKED and its legend now carry phase alone.
const glossaryConfig = {
  brief: { max_lines: 25 },
  vocab: { phase: ['P1'] },
  glossary: {
    phase: { P1: 'The first working version.' },
  },
};

test('P8-26: a legend line explains only the phase codes actually shown', () => {
  const next = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: [], phase: 'P1' };
  const out = renderBrief({ items: [next], events: [], stages, config: glossaryConfig });
  // The legend contains the phase description (may wrap across lines)
  assert.match(out, /Legend: P1 = The first working version\./);
});

test('P8-26: no glossary configured means no legend line at all', () => {
  const next = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: [], phase: 'P1' };
  const out = renderBrief({ items: [next], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.equal(out.includes('Legend:'), false);
});

test('P8-26: a code with no glossary entry is left out of the legend rather than printed blank', () => {
  const next = { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: [], phase: 'P2' };
  const config = { brief: { max_lines: 25 }, vocab: { phase: ['P1', 'P2'] }, glossary: { phase: { P1: 'Phase one.' } } };
  const out = renderBrief({ items: [next], events: [], stages, config });
  assert.equal(out.includes('Legend:'), false, 'P2 has no glossary entry, so no legend is printed at all');
});

test('P8-26: the legend never pushes the brief past its line cap', () => {
  const items = makeItems(20).map((item, index) => ({ ...item, stage: 'backlog', owner: null, flag: null, deps: [], phase: `P${index % 4}` }));
  const config = {
    brief: { max_lines: 12 },
    vocab: { phase: ['P0', 'P1', 'P2', 'P3'] },
    glossary: {
      phase: { P0: 'Phase zero.', P1: 'Phase one.', P2: 'Phase two.', P3: 'Phase three.' },
    },
  };
  const out = renderBrief({ items, events: [], stages, config });
  assert.ok(out.trimEnd().split('\n').length <= 12, 'the cap wins over legend completeness');
});

test('P8-27: the legend wraps to multiple rows and no row exceeds the computed width', () => {
  // Create a legend with long descriptions that will wrap
  const items = makeItems(2).map((item, index) => ({
    ...item,
    stage: 'backlog',
    owner: null,
    flag: null,
    deps: [],
    phase: index === 0 ? 'P1' : 'P2',
  }));
  const config = {
    brief: { max_lines: 25 },
    vocab: { phase: ['P1', 'P2'] },
    glossary: {
      phase: {
        P1: 'The first working version: the core this product is useless without.',
        P2: 'The work that makes the core usable day to day, and stays useful long after that.',
      },
    },
  };
  const out = renderBrief({ items, events: [], stages, config });
  const lines = out.split('\n');
  const legendStart = lines.findIndex((line) => line.startsWith('Legend:'));
  assert.ok(legendStart >= 0, 'legend should be present');

  // Find all legend lines (first starts with "Legend:", continuations start with 7 spaces)
  const legendLines = [];
  for (let i = legendStart; i < lines.length; i++) {
    if (i === legendStart) {
      legendLines.push(lines[i]);
    } else if (lines[i].startsWith('       ')) {
      legendLines.push(lines[i]);
    } else {
      break;
    }
  }

  // Legend should wrap to multiple lines
  assert.ok(legendLines.length > 1, `legend should wrap to multiple lines, got ${legendLines.length}`);

  // No row should exceed the wrap width of 76
  const WRAP_WIDTH = 76;
  for (const line of legendLines) {
    assert.ok(line.length <= WRAP_WIDTH, `legend line exceeds width: ${line.length} chars: ${line}`);
  }

  // No wrap should happen mid-word
  for (const line of legendLines) {
    // Check that lines don't end with a space (which would indicate a word-break problem)
    assert.ok(!line.endsWith(' '), `legend line should not end with space: ${line}`);
  }
});

test('P8-27: wrapped legend rows are counted against the budget and dropped if they do not fit', () => {
  // Create items with a long phase description that will wrap to multiple lines
  const items = makeItems(10).map((item, index) => ({
    ...item,
    stage: 'backlog',
    owner: null,
    flag: null,
    deps: [],
    phase: 'P1',
  }));
  const config = {
    brief: { max_lines: 10 }, // Very tight budget
    vocab: { phase: ['P1'] },
    glossary: {
      phase: {
        P1: 'The first working version: the core this product is useless without. More text to ensure wrapping and force it past the tight budget here too.',
      },
    },
  };
  const out = renderBrief({ items, events: [], stages, config });
  const lines = out.trimEnd().split('\n');

  // With such a tight budget, the legend should be dropped if it wraps to multiple lines
  assert.ok(lines.length <= 10, `output should respect line limit: ${lines.length} lines`);

  // If the legend is present, it must fit entirely within the budget
  const hasLegend = lines.some((line) => line.startsWith('Legend:'));
  if (hasLegend) {
    const legendStart = lines.findIndex((line) => line.startsWith('Legend:'));
    let legendLineCount = 1;
    for (let i = legendStart + 1; i < lines.length; i++) {
      if (lines[i].startsWith('       ')) {
        legendLineCount++;
      } else {
        break;
      }
    }
    // Verify that the total lines including legend do not exceed the budget
    assert.ok(lines.length <= 10, 'legend should not cause line limit to be exceeded');
  }
});

test('P8-27: continuation lines are indented with 7 spaces to align with legend text', () => {
  const items = makeItems(2).map((item) => ({
    ...item,
    stage: 'backlog',
    owner: null,
    flag: null,
    phase: 'P1',
  }));
  const config = {
    brief: { max_lines: 25 },
    vocab: { phase: ['P1'] },
    glossary: {
      phase: {
        P1: 'The first working version that is super duper long to ensure multiple lines of wrapping and stays aligned across every continuation row it produces.',
      },
    },
  };
  const out = renderBrief({ items, events: [], stages, config });
  const lines = out.split('\n');
  const legendStart = lines.findIndex((line) => line.startsWith('Legend:'));
  assert.ok(legendStart >= 0, 'legend should be present');

  // All continuation lines should start with exactly 7 spaces
  for (let i = legendStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith('       ')) {
      assert.ok(/^       [^ ]/.test(lines[i]), `continuation line should have exactly 7 spaces of indent: ${lines[i]}`);
    } else if (lines[i].length > 0) {
      break; // Legend section ended
    }
  }
});

// T-0006 gave `brief --json` its buckets; T-0032 made it return the brief
// itself — the buckets with titles and waiting-on facts — instead of the
// whole board plus a copy of the human text.
// Stage ids match the shipped default pipeline (templates/stages.json), which
// is what a scratch board actually loads.
const bucketItems = () => [
  { id: 'D-1', title: 'Live dispatch', stage: 'building', owner: null, flag: null, deps: [] },
  { id: 'F-1', title: 'Moved past first stage', stage: 'building', owner: 'human:rahil', flag: null, deps: [] },
  { id: 'B-1', title: 'Waiting on a dependency', stage: 'reviewed', owner: null, flag: null, deps: ['F-1'] },
  { id: 'B-2', title: 'Flagged blocked', stage: 'backlog', owner: null, flag: 'blocked', deps: [] },
  { id: 'T-1', title: 'Held for triage', stage: 'backlog', owner: null, flag: 'needs-triage', deps: [] },
  { id: 'N-1', title: 'Ready for pickup', stage: 'backlog', owner: null, flag: null, deps: [] },
  // Claimed but never moved (P8-24) and terminal: in no bucket at all.
  { id: 'C-1', title: 'Claimed only', stage: 'backlog', owner: 'human:rahil', flag: null, deps: [] },
  { id: 'X-1', title: 'Already finished', stage: 'verified', owner: null, flag: null, deps: [] },
];
const bucketState = (events = [{ type: 'dispatch', item: 'D-1', by: 'scheduler' }]) => ({
  items: bucketItems(), events, stages, config: { brief: { max_lines: 25 } }, git: { branch: 'main', sha: '895e249' },
});

// The command reads stages and config through the store, so these run against
// a real scratch board -- the same harness as the read-only test above.
function bucketBoard(events = [{ type: 'dispatch', item: 'D-1', by: 'scheduler' }]) {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-json-'));
  const store = createStore(root); store.ensure();
  store.writeItems(bucketItems());
  writeFileSync(store.paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  return { root, store };
}

async function bucketJson(flags) {
  const { store } = bucketBoard();
  let json = '';
  await runBrief({ store, root: store.root, flags, stdout: { write: (value) => { json += value; } } });
  return JSON.parse(json);
}

// T-0032 — `brief --json` returns the brief — the same facts the text
// conveys, structured — and nothing else. It used to spread the whole state
// (items, the full event log, config, stages) plus a duplicate of the human
// text: ~54k chars on a 100-item board, ~33x the text, paid on every poll by
// the exact audience told to prefer JSON.
test('brief --json returns the brief, not the database', async () => {
  const parsed = await bucketJson({ json: true });
  for (const forbidden of ['items', 'events', 'stages', 'config', 'output', 'brief', 'git_root']) {
    assert.ok(!(forbidden in parsed), `--json must not ship '${forbidden}'`);
  }
  assert.deepEqual(parsed, {
    open: 7,
    in_flight: 2,
    blocked: 2,
    finished: 1,
    // gitState reads the enclosing repo; a tempdir has none.
    git: null,
    dispatched: [{ id: 'D-1', title: 'Live dispatch', stage: 'building', next_stage: 'built', owner: null }],
    in_flight: [{ id: 'F-1', title: 'Moved past first stage', stage: 'building', owner: 'human:rahil' }],
    stranded: [],
    blocked: [
      { id: 'B-1', title: 'Waiting on a dependency', flag: null, waiting_on: 'F-1', waiting_on_stage: 'building' },
      { id: 'B-2', title: 'Flagged blocked', flag: 'blocked', waiting_on: null, waiting_on_stage: null },
    ],
    needs_triage: [{ id: 'T-1', title: 'Held for triage', created_by: null }],
    next_unblocked: [{ id: 'N-1', title: 'Ready for pickup', phase: null }],
    rules: [
      'Rules: use `gw add` for work someone else could pick up; checklists go in notes.',
      '       Finished work is out of the open counts: `gw list --stage verified` lists it.',
      "       Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate. Never edit .gatewright/ by hand.",
    ],
  });
  const everyId = [...parsed.dispatched, ...parsed.in_flight, ...parsed.blocked, ...parsed.needs_triage, ...parsed.next_unblocked].map((entry) => entry.id);
  assert.ok(!everyId.includes('C-1'), 'a claimed-but-unmoved item belongs in no bucket');
  assert.ok(!everyId.includes('X-1'), 'a terminal item belongs in no bucket');
});

test('brief --json payload stays within a polling budget on a 100-item board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-json-100-'));
  const store = createStore(root); store.ensure();
  const items = makeItems(100); store.writeItems(items);
  const events = makeEvents(items);
  writeFileSync(store.paths.events, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  let json = '';
  await runBrief({ store, root: store.root, flags: { json: true }, stdout: { write: (value) => { json += value; } } });
  const parsed = JSON.parse(json);
  assert.ok(parsed.dispatched.length + parsed.in_flight.length + parsed.blocked.length + parsed.next_unblocked.length > 0);
  assert.ok(json.length < 20_000, `a 100-item poll cost ${json.length} chars`);
});

test('brief --json buckets agree with the rendered text, bucket for bucket', async () => {
  const parsed = await bucketJson({ json: true });
  const text = renderBrief({
    items: bucketItems(), events: [{ type: 'dispatch', item: 'D-1', by: 'scheduler' }], stages, config: { brief: { max_lines: 25 } }, git: { branch: 'main', sha: '895e249' },
  });
  assert.match(text, /DISPATCHED TO YOU[\s\S]*?D-1/);
  assert.match(text, /IN FLIGHT[\s\S]*?F-1/);
  assert.match(text, /BLOCKED[\s\S]*?B-1.*waiting on F-1 \(Building\)/);
  assert.match(text, /NEEDS TRIAGE \(1\)[\s\S]*?T-1/);
  assert.match(text, /NEXT UNBLOCKED[\s\S]*?N-1/);
  // T-0036 — a NEEDS TRIAGE row with no instruction attached sends the reader
  // hunting; the row must name the command that clears the hold, like `gw
  // check` already does.
  assert.match(text, /NEEDS TRIAGE \(1\)[\s\S]*?run `gw triage T-1 --approve` to clear the hold, or `gw triage T-1 --drop` to discard it/);
  assert.deepEqual(parsed.blocked[1], { id: 'B-2', title: 'Flagged blocked', flag: 'blocked', waiting_on: null, waiting_on_stage: null }, 'a flagged-blocked item with no deps is waiting on nothing');
  assert.deepEqual(parsed.blocked[0].waiting_on, 'F-1', 'a dep-blocked item names the dependency the text suffix names');
  assert.deepEqual(briefJson({ items: [], events: [], stages, config: {}, git: null }), {
    open: 0, in_flight: 0, blocked: 0, finished: 0, git: null,
    dispatched: [], in_flight: [], stranded: [], blocked: [], needs_triage: [], next_unblocked: [],
    rules: briefJson({ items: [], events: [], stages, config: {}, git: null }).rules,
  });
});

test('brief --json applies --me exactly as the text does', async () => {
  const parsed = await bucketJson({ json: true, me: 'human:rahil' });
  assert.deepEqual(parsed.dispatched, [], 'a dispatch by someone else is not dispatched to me');
  assert.deepEqual(parsed.in_flight.map((entry) => entry.id), ['F-1'], 'in flight keeps only items owned by me');
  assert.equal(parsed.in_flight[0].owner, 'human:rahil');
});

// T-0009 — rendering's half of the guard: whatever a stored title holds, one
// item renders as one row. `gw add` refuses newline titles now; this defends
// the data written before it did.
test('a stored newline title renders as one brief row with the newline collapsed', () => {
  const item = { ...makeItems(1)[0], id: 'P1-01', title: 'a\nb', stage: 'specified', owner: null, flag: null, deps: [] };
  const out = renderBrief({ items: [item], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.equal(out.includes('a\nb'), false, 'the raw newline must never reach the output');
  assert.match(out, /P1-01\s+a b/);
  assert.equal(sanitizeTitle('a\r\nb\tc'), 'a b c');
});

// T-0020 — the one definition of "flagged", computed here and exported so
// the viewer and any CLI surface count the same set. A literal flag counts,
// and so does work parked in the paused-role stage without one (`gw move
// <id> paused` never writes a flag).
test('isFlagged counts a literal flag, a paused-stage item, and nothing else', () => {
  const flaggedStages = { stages: [{ id: 'backlog' }, { id: 'building' }], terminal: [], extra: [{ id: 'paused' }] };
  assert.equal(isFlagged({ id: 'A', flag: 'blocked', stage: 'backlog' }, flaggedStages), true);
  assert.equal(isFlagged({ id: 'B', flag: null, stage: 'paused' }, flaggedStages), true, 'parked in the paused stage without a flag is still flagged');
  assert.equal(isFlagged({ id: 'C', flag: null, stage: 'backlog' }, flaggedStages), false);
  assert.equal(isFlagged({ id: 'D', flag: 'needs-triage', stage: 'backlog' }, flaggedStages), true);
  assert.equal(isFlagged({ id: 'E', flag: 'conflict', stage: 'backlog' }, flaggedStages), true);
  // Without a paused-role stage in the pipeline, only a literal flag counts.
  const noPausedStages = { stages: [{ id: 'backlog' }, { id: 'building' }], terminal: [], extra: [] };
  assert.equal(isFlagged({ id: 'F', flag: null, stage: 'backlog' }, noPausedStages), false);
  assert.equal(isFlagged({ id: 'G', flag: 'blocked', stage: 'backlog' }, noPausedStages), true);
});

test('flaggedItems filters with the same definition, and terminal work is not flagged by its stage', () => {
  const flaggedStages = { stages: [{ id: 'backlog' }, { id: 'verified' }], terminal: ['verified'], extra: [{ id: 'paused' }] };
  const items = [
    { id: 'A', flag: null, stage: 'backlog' },
    { id: 'B', flag: 'blocked', stage: 'backlog' },
    { id: 'C', flag: null, stage: 'paused' },
    { id: 'D', flag: null, stage: 'verified' },
  ];
  assert.deepEqual(flaggedItems(items, flaggedStages).map((item) => item.id), ['B', 'C']);
});

test('outstandingDispatches names the items a run has not ended or cancelled for', () => {
  const events = [
    { type: 'dispatch', item: 'A', by: 'scheduler' },
    { type: 'dispatch', item: 'B', by: 'scheduler' },
    { type: 'run_ended', item: 'A', by: 'scheduler' },
    { type: 'dispatch', item: 'C', by: 'scheduler' },
    { type: 'cancel', item: 'C', by: 'human:test' },
  ];
  assert.deepEqual(outstandingDispatches(events), ['B']);
  assert.deepEqual(outstandingDispatches([]), []);
});

// T-0066 — the headline used to read "0 in flight" for an item someone had
// claimed AND moved to building, because the needs-triage hold excluded it
// from the bucket. The hold is a review requirement, not evidence that work
// stopped: an item with an owner, in a non-initial non-terminal stage, is in
// flight — flag or no flag. The board below is constructed with a known
// count: two claimed-and-moved items (one still held for triage), one
// released mid-pipeline item, one claimed-but-unmoved, and one unowned
// pick-up candidate.
test('T-0091: brief counts exactly the owned mid-pipeline items and names released work separately', () => {
  const items = [
    { ...makeItems(1)[0], id: 'P1-01', stage: 'building', owner: 'agent:a', flag: 'needs-triage', deps: [] },
    { ...makeItems(1)[0], id: 'P1-02', stage: 'building', owner: 'agent:b', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-03', stage: 'building', owner: null, flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-04', stage: 'backlog', owner: 'agent:c', flag: 'needs-triage', deps: [] },
    { ...makeItems(1)[0], id: 'P1-05', stage: 'backlog', owner: null, flag: null, deps: [] },
  ];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /^gw · 5 open · 2 in flight · 0 blocked/m, `got:\n${out}`);
  assert.match(out, /IN FLIGHT[\s\S]*P1-01/);
  assert.match(out, /IN FLIGHT[\s\S]*P1-02/);
  assert.match(out, /STRANDED[\s\S]*P1-03/, 'released mid-pipeline work has a compact, actionable home');
  // The hold is still true and still shown; it no longer hides the work.
  assert.match(out, /NEEDS TRIAGE \(2\)[\s\S]*P1-01[\s\S]*P1-04/);
});

// T-0066 — after an item reached verified it vanished from the brief
// entirely, so a fresh agent could not tell that anything had already
// happened. The headline now carries the finished count, and the footer
// names the command that lists them. Dropped is not finished.
test('T-0066: the headline counts finished work and the footer names how to list it', () => {
  const items = [
    { ...makeItems(1)[0], id: 'P1-01', stage: 'verified', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-02', stage: 'dropped', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-03', stage: 'backlog', owner: null, flag: null, deps: [] },
  ];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /^gw · 1 open · 0 in flight · 0 blocked · 1 finished/m, `got:\n${out}`);
  assert.match(out, /Finished work is out of the open counts: `gw list --stage verified` lists it\./);
  assert.doesNotMatch(out, /2 finished/);
  // A board with nothing finished prints the headline exactly as before.
  const clean = renderBrief({ items: [items[2]], events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(clean, /^gw · 1 open · 0 in flight · 0 blocked$/m);
  assert.equal(clean.includes('finished'), false);
});

// T-0073 — the brief's BLOCKED row used to dead-end on "waiting on X
// (dropped)" with no command, the only state in the product that did. It
// must name the same exact edit `gw next` names, keeping the live deps.
test('T-0073: the blocked row advises the same edit next names, keeping live deps', () => {
  const stranded = { ...makeItems(1)[0], id: 'P1-02', stage: 'dropped', owner: null, flag: null, deps: [] };
  const alive = { ...makeItems(1)[0], id: 'P1-03', stage: 'specified', owner: null, flag: null, deps: [] };
  const items = [
    { ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: ['P1-02', 'P1-03'] },
    stranded,
    alive,
  ];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /BLOCKED[\s\S]*?waiting on P1-02 \(dropped\) — run `gw edit P1-01 --deps P1-03`/);
});

test('T-0073: the advice says --deps "" only when the stranded dep was the last one', () => {
  const stranded = { ...makeItems(1)[0], id: 'P1-02', stage: 'dropped', owner: null, flag: null, deps: [] };
  const items = [{ ...makeItems(1)[0], id: 'P1-01', stage: 'backlog', owner: null, flag: null, deps: ['P1-02'] }, stranded];
  const out = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(out, /waiting on P1-02 \(dropped\) — run `gw edit P1-01 --deps ""`/);
});

// T-0069 — `--me` used to filter only the DISPATCHED and IN FLIGHT buckets,
// so on a board where the other actors' items sat elsewhere the output was
// byte-identical to the unfiltered brief. Now every section filters through
// one ownership rule, and an empty view says so instead of pretending the
// board is empty.
test('T-0069: --me filters every section to the actor and names an empty view', () => {
  const items = [
    { ...makeItems(1)[0], id: 'P1-01', stage: 'building', owner: 'agent:other', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-02', stage: 'backlog', owner: null, flag: 'blocked', deps: [] },
    { ...makeItems(1)[0], id: 'P1-03', stage: 'backlog', owner: null, flag: 'needs-triage', deps: [] },
    { ...makeItems(1)[0], id: 'P1-04', stage: 'backlog', owner: null, flag: null, deps: [] },
  ];
  const plain = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } });
  assert.match(plain, /agent:other/);
  assert.match(plain, /^gw · 4 open · 1 in flight · 1 blocked/m);
  const mine = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } }, { me: 'agent:whoever' });
  assert.doesNotMatch(mine, /agent:other/, 'the whole view must be filtered to the actor');
  assert.doesNotMatch(mine, /P1-02[\s\S]*BLOCKED|BLOCKED[\s\S]*P1-02/, 'a blocked item owned by no one is not mine');
  assert.match(mine, /^gw · 0 open · 0 in flight · 0 blocked/m);
  assert.match(mine, /Nothing open is owned by agent:whoever\. Run `gw brief` for the whole board\./);
});

test('T-0069: --me keeps a bare name matching its qualified owner form', () => {
  const items = [{ ...makeItems(1)[0], id: 'P1-01', stage: 'built', owner: 'human:rahil', flag: null, deps: [] }];
  const mine = renderBrief({ items, events: [], stages, config: { brief: { max_lines: 25 } } }, { me: 'rahil' });
  assert.match(mine, /^gw · 1 open · 1 in flight/m);
  assert.match(mine, /IN FLIGHT[\s\S]*P1-01/);
});

test('T-0069: brief --json applies --me to every bucket, and the buckets agree with the text', async () => {
  const items = [
    { id: 'M-1', title: 'Mine, moving', stage: 'building', owner: 'agent:me', flag: null, deps: [] },
    { id: 'M-2', title: 'Mine, blocked', stage: 'backlog', owner: 'agent:me', flag: 'blocked', deps: [] },
    { id: 'O-1', title: 'Theirs, moving', stage: 'building', owner: 'agent:other', flag: null, deps: [] },
  ];
  const parsed = await (async () => {
    const root = mkdtempSync(join(tmpdir(), 'gw-brief-json-'));
    const store = createStore(root); store.ensure();
    store.writeItems(items);
    let json = '';
    await runBrief({ store, root: store.root, flags: { json: true, me: 'agent:me' }, stdout: { write: (value) => { json += value; } } });
    return JSON.parse(json);
  })();
  assert.equal(parsed.open, 2);
  assert.deepEqual(parsed.in_flight.map((entry) => entry.id), ['M-1']);
  assert.deepEqual(parsed.blocked.map((entry) => entry.id), ['M-2']);
  assert.deepEqual(parsed.next_unblocked, []);
  assert.deepEqual(parsed.needs_triage, []);
});

test('T-0069: a bare --me resolves to the actor and filters the board', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-brief-me-'));
  const store = createStore(root); store.ensure();
  const items = [
    { ...makeItems(1)[0], id: 'P1-01', title: 'Theirs', stage: 'building', owner: 'agent:other', flag: null, deps: [] },
    { ...makeItems(1)[0], id: 'P1-02', title: 'Mine', stage: 'building', owner: 'agent:me', flag: null, deps: [] },
  ];
  store.writeItems(items);
  let out = '';
  await runBrief({ store, root: store.root, actor: 'agent:me', flags: { me: true }, stdout: { write: (value) => { out += value; } } });
  assert.match(out, /^gw · 1 open · 1 in flight/m);
  assert.match(out, /P1-02/);
  assert.equal(out.includes('P1-01'), false, 'the other actor\'s work must not leak into my view');
  // The same board, --me naming the actor explicitly, must agree with the bare form.
  let explicit = '';
  await runBrief({ store, root: store.root, actor: 'human:rahil', flags: { me: 'agent:me' }, stdout: { write: (value) => { explicit += value; } } });
  assert.equal(explicit, out);
});
