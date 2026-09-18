import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/move.js';
import { run as check } from '../lib/commands/check.js';
import { RuleError, UsageError } from '../lib/cli/errors.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = {
  stages: [
    { id: 'backlog' }, { id: 'specified' }, { id: 'building', requires: { owner: true } },
    { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
    { id: 'reviewed' }, { id: 'merged' }, { id: 'verified', requires: { evidence_min: 2 } },
  ], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }],
};
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', flag: null, owner: null, deps: [], evidence: [], updated: '2020-01-01T00:00:00.000Z', gh: null, ...over });

function board(items = [item()], config = {}, stagesFixture = stages) {
  const root = mkdtempSync(join(tmpdir(), 'gw-move-'));
  const store = createStore(root); store.ensure(); store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stagesFixture));
  writeFileSync(store.paths.config, JSON.stringify({ github: { enabled: false, comment_on_move: true }, ...config }));
  return { root, store };
}
function ctx(b, positionals, flags = {}) { return { flags, positionals, store: b.store, root: b.root, actor: 'human:test', env: {}, stdout: { write() {} }, stderr: { write() {} } }; }

test('--force never bypasses requires', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['P1-01', 'built'], { force: true })), (error) => error instanceof RuleError && /built: Needs at least one new piece of evidence/.test(error.failures.join('\n')));
  assert.equal(b.store.readItems()[0].stage, 'backlog');
});

test('force jump to merged refuses every skipped owner evidence and PR gate', () => {
  const b = board();
  assert.throws(() => execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'merged', '--force'], { cwd: b.root, encoding: 'utf8' }), (error) => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /building: needs an owner/);
    assert.match(error.stderr, /built: Needs at least one new piece of evidence/);
    assert.match(error.stderr, /in_review: Evidence supplied with the move must include a link to a pull request/);
    return true;
  });
  assert.equal(b.store.readItems()[0].stage, 'backlog');
});

// T-0029 — the accepted consequence, asserted: evidence recorded at an earlier
// visit earns nothing on re-entry. A forced move onto recorded evidence alone
// refuses; only fresh entries clear the gate.
test('a forced jump re-passes its gate only on fresh evidence, not on what is already recorded', () => {
  const b = board([item({ stage: 'specified', owner: 'human:test', evidence: ['abc123'] })]);
  assert.throws(() => run(ctx(b, ['P1-01', 'built'], { force: true })), (error) => error instanceof RuleError && /built: Needs at least one new piece of evidence/.test(error.failures.join('\n')));
  assert.equal(b.store.readItems()[0].stage, 'specified');
  run(ctx(b, ['P1-01', 'built'], { force: true, evidence: ['commit def456'] }));
  assert.equal(b.store.readItems()[0].stage, 'built');
});

test('an item progressed through every gate in order remains valid to move and check', () => {
  const b = board([item({ stage: 'backlog' })]);
  run(ctx(b, ['P1-01', 'specified']));
  b.store.writeItems([item({ stage: 'specified', owner: 'human:test', evidence: [] })]);
  run(ctx(b, ['P1-01', 'building']));
  run(ctx(b, ['P1-01', 'built'], { evidence: ['abc123'] }));
  run(ctx(b, ['P1-01', 'in_review'], { evidence: ['https://github.com/a/b/pull/1'] }));
  run(ctx(b, ['P1-01', 'reviewed']));
  run(ctx(b, ['P1-01', 'merged']));
  assert.equal(b.store.readItems()[0].stage, 'merged');
  let output = '';
  assert.equal(check({ ...ctx(b, []), stdout: { write(text) { output += text; } } }), 0);
  assert.equal(output, 'Board is clean.\n');
});

test('move counts command evidence toward the target requirement and writes one move event', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  run(ctx(b, ['P1-01', 'built'], { evidence: ['abc123'] }));
  const moved = b.store.readItems()[0];
  assert.equal(moved.stage, 'built');
  // T-0029 — evidence is recorded with the stage whose move supplied it, so
  // the gate that accepted it stays auditable and no later gate counts it.
  assert.deepEqual(moved.evidence, [{ text: 'abc123', stage: 'built' }]);
  assert.notEqual(moved.updated, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(b.store.readEvents().map(({ type, item: id, from, to, by, evidence }) => ({ type, item: id, from, to, by, evidence })), [{ type: 'move', item: 'P1-01', from: 'building', to: 'built', by: 'human:test', evidence: ['abc123'] }]);
});

test('move prints exactly one confirmation line on success', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  let output = '';
  run({ ...ctx(b, ['P1-01', 'built'], { evidence: ['abc1234', 'test/scheduler.test.js'] }), stdout: { write(text) { output += text; } } });
  assert.equal(output, 'P1-01  building → built  ·  evidence: abc1234, test/scheduler.test.js\n');
});

test('move refuses an out-of-order pipeline target without force but allows side stages', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['P1-01', 'built'])), (error) => error instanceof RuleError
    && error.message === 'specified: move here first (built is 2 stages beyond specified): run `gw move P1-01 specified`');
  run(ctx(b, ['P1-01', 'paused']));
  assert.equal(b.store.readItems()[0].stage, 'paused');
  const dropped = board(); run(ctx(dropped, ['P1-01', 'dropped']));
  assert.equal(dropped.store.readItems()[0].stage, 'dropped');
});

test('move rejects unknown items, unknown stages, same stages, and terminal moves', () => {
  const b = board();
  for (const args of [['none', 'building'], ['P1-01', 'none'], ['P1-01', 'backlog']]) assert.throws(() => run(ctx(b, args)), UsageError);
  assert.throws(() => run(ctx(b, ['P1-01', 'none'])), (error) => error instanceof UsageError && /unknown stage: none; valid stages: .*backlog.*paused/.test(error.message), 'an unknown stage names the stages that do exist');
  assert.throws(() => run(ctx(b, ['P1-01', 'backlog'])), /already in stage backlog; run `gw show P1-01`/);
  const terminal = board([item({ stage: 'verified', evidence: ['a', 'b'] })]);
  assert.throws(() => run(ctx(terminal, ['P1-01', 'backlog'], { force: true })), /finished in terminal stage verified.*run `gw move P1-01 paused --force`, then `gw move P1-01 specified --force`/);
  run(ctx(terminal, ['P1-01', 'paused'], { force: true }));
  assert.equal(terminal.store.readItems()[0].stage, 'paused');
});

// T-0034 — the terminal refusal used to print `gw move <id> <side-stage>
// --force`, a placeholder naming no stage that exists. The fix is only real
// if the printed commands run: follow them and the item is back in the
// pipeline.
test('the terminal refusal names real stages, and following them recovers the item', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  run(ctx(b, ['P1-01', 'dropped']));
  assert.equal(b.store.readItems()[0].stage, 'dropped');

  let message = '';
  try { run(ctx(b, ['P1-01', 'building'])); } catch (error) { message = error.message; }
  assert.match(message, /run `gw move P1-01 paused --force`, then `gw move P1-01 building --force`/);
  assert.doesNotMatch(message, /<side-stage>/);

  run(ctx(b, ['P1-01', 'paused'], { force: true }));
  run(ctx(b, ['P1-01', 'building'], { force: true }));
  assert.equal(b.store.readItems()[0].stage, 'building', 'the two printed commands recover the item');
});

test('move clears a paused flag and queues a linked GitHub comment without calling gh', () => {
  const b = board([item({ stage: 'paused', flag: 'paused', owner: 'human:test', gh: { number: 7 } })], { github: { enabled: true, comment_on_move: true } });
  run(ctx(b, ['P1-01', 'building'], { force: true }));
  assert.equal(b.store.readItems()[0].flag, null);
  const event = b.store.readEvents()[0]; assert.equal(event.type, 'move'); assert.equal(event.queued_comment, true);
});

test('move preserves a paused flag when leaving a non-paused stage', () => {
  const b = board([item({ stage: 'specified', flag: 'paused', owner: 'human:test' })]);
  run(ctx(b, ['P1-01', 'building']));
  assert.equal(b.store.readItems()[0].flag, 'paused');
});

test('gw move works through the real binary with the expected exit code', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'built', '--evidence', 'abc123'], { cwd: b.root, encoding: 'utf8' });
  assert.equal(b.store.readItems()[0].stage, 'built');
  assert.throws(() => execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'verified'], { cwd: b.root, encoding: 'utf8' }), (error) => error.status === 1);
});

// T-0010 — refusing a terminal-stage move is the board refusing based on
// item state, the same class as skipping a stage or failing an evidence
// rule, so it exits 1 (RuleError) like its siblings instead of 2.
test('a terminal-stage move refusal is a RuleError with the same message, at exit 1', () => {
  const b = board([item({ stage: 'verified', evidence: ['a', 'b'] })]);
  assert.throws(
    () => run(ctx(b, ['P1-01', 'merged'])),
    (error) => error instanceof RuleError
      && error.message === 'item P1-01 is finished in terminal stage verified; if this is a mistake, run `gw move P1-01 paused --force`, then `gw move P1-01 specified --force`',
  );
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'merged'], { cwd: b.root, encoding: 'utf8' }),
    (error) => error.status === 1,
  );
});

// T-0029 — the regression test whose absence let the defect ship. The last
// gate of the shipped pipeline counted the item's LIFETIME evidence, so an
// item that had walked the pipeline cleanly sailed `verified` with no
// evidence at all: the product's central claim could not fail at its last
// checkpoint. Walk the real shipped pipeline through the real binary and
// demand the refusal sequence, exactly as an operator would meet it.
test('the shipped pipeline refuses the verified gate without fresh, distinct evidence supplied with the move', () => {
  const shipped = JSON.parse(readFileSync(new URL('../templates/stages.json', import.meta.url), 'utf8'));
  const b = board([item({ stage: 'backlog', scope: 'done means verified behaviour' })], {}, shipped);
  const gw = (args) => execFileSync(process.execPath, [BIN, ...args], { cwd: b.root, encoding: 'utf8' });
  const refused = (args) => {
    try { gw(args); } catch (error) { return error; }
    throw new Error(`gw move ${args.join(' ')} should have refused`);
  };
  gw(['claim', 'P1-01']);
  gw(['move', 'P1-01', 'building']);
  gw(['move', 'P1-01', 'built', '--evidence', 'commit abc']);
  gw(['move', 'P1-01', 'in_review', '--evidence', 'https://github.com/gw/gw/pull/42']);
  gw(['move', 'P1-01', 'reviewed']);
  gw(['move', 'P1-01', 'merged']);
  assert.equal(b.store.readItems()[0].stage, 'merged');

  // No evidence at all: the refusal names what it wants (T-0033).
  const bare = refused(['move', 'P1-01', 'verified']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /verified: Needs at least two new pieces of evidence, distinct from anything already recorded: run `gw move P1-01 verified --evidence <e>`/);

  // A string already on the item is not fresh evidence.
  assert.match(refused(['move', 'P1-01', 'verified', '--evidence', 'commit abc']).stderr, /Needs at least two new pieces of evidence/);
  assert.equal(b.store.readItems()[0].stage, 'merged');

  // Two copies of one string are one entry, not two.
  assert.match(refused(['move', 'P1-01', 'verified', '--evidence', 'x', '--evidence', 'x']).stderr, /Needs at least two new pieces of evidence/);

  // Two genuinely new, distinct entries clear the gate.
  gw(['move', 'P1-01', 'verified', '--evidence', 'run 1 green on target', '--evidence', 'https://ci.example.test/run/99']);
  const final = b.store.readItems()[0];
  assert.equal(final.stage, 'verified');
  assert.deepEqual(final.evidence.slice(-2), [
    { text: 'run 1 green on target', stage: 'verified' },
    { text: 'https://ci.example.test/run/99', stage: 'verified' },
  ]);
});
