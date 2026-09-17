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
import { renderBrief, inFlightTitles } from '../lib/brief.js';
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

test('P8-24: an item is in flight once it has actually moved past its first stage, owned or not', () => {
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

test('P8-24: inFlightTitles agrees with the brief -- claimed-but-unmoved is excluded, progressed is included', () => {
  const claimed = { ...makeItems(1)[0], id: 'P1-01', title: 'Claimed only', stage: 'backlog', owner: 'human:rahil', flag: null, deps: [] };
  const moved = { ...makeItems(1)[0], id: 'P1-02', title: 'Actually moved', stage: 'specified', owner: null, flag: null, deps: [] };
  const titles = inFlightTitles({ items: [claimed, moved], events: [], stages });
  assert.deepEqual(titles, ['Actually moved']);
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
  const items = makeItems(2).map((item, index) => ({
    ...item,
    stage: 'backlog',
    owner: null,
    flag: null,
    deps: [],
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
