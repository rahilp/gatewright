import './helpers/isolate-env.js';
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
import { run as claim } from '../lib/commands/claim.js';
import { run as triage } from '../lib/commands/triage.js';
import { RuleError, UsageError } from '../lib/cli/errors.js';
import { runPrintedCommand } from './helpers/printed-command.js';

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
function ctx(b, positionals, flags = {}, actor = 'human:test') { return { flags, positionals, store: b.store, root: b.root, actor, env: {}, stdout: { write() {} }, stderr: { write() {} } }; }

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
  // The board's owner gate (T-0072) reads the real actor, so the binary run
  // is made as the item's owner, the way a real operator would.
  const env = { ...process.env, GW_ACTOR: 'human:test' };
  execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'built', '--evidence', 'abc123'], { cwd: b.root, env, encoding: 'utf8' });
  assert.equal(b.store.readItems()[0].stage, 'built');
  assert.throws(() => execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'verified'], { cwd: b.root, env, encoding: 'utf8' }), (error) => error.status === 1);
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
  const printed = bare.stderr.match(/run `([^`]+)`/);
  assert.ok(printed, 'the refusal supplies one complete recovery command');
  const next = JSON.parse(gw(['next', 'P1-01', '--json']));
  assert.ok(next.transitions.verified.failures.includes(`verified: ${bare.stderr.match(/verified: (.*)/)[1]}`), 'the machine-readable transition exposes the same runnable advice');
  // T-0087 — execute the exact command we displayed, rather than rebuilding
  // the flags in this test. This is the only shape that catches advice whose
  // number of evidence flags is too small (or whose values de-duplicate).
  const recovered = runPrintedCommand(b.root, printed[1]);
  assert.equal(recovered.error, undefined, recovered.error?.message);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(b.store.readItems()[0].stage, 'verified', 'the copied command clears the gate it names');

  // A string already on the item is not fresh evidence.
  const duplicateBoard = board([item({ stage: 'merged', scope: 'done means verified behaviour', owner: 'human:test', evidence: [
    { text: 'commit abc', stage: 'built' }, { text: 'https://github.com/gw/gw/pull/42', stage: 'in_review' },
  ] })], {}, shipped);
  const duplicate = (args) => {
    try { execFileSync(process.execPath, [BIN, ...args], { cwd: duplicateBoard.root, encoding: 'utf8' }); } catch (error) { return error; }
    throw new Error(`gw move ${args.join(' ')} should have refused`);
  };
  assert.match(duplicate(['move', 'P1-01', 'verified', '--evidence', 'commit abc', '--by', 'human:test']).stderr, /Needs at least two new pieces of evidence/);
  assert.equal(duplicateBoard.store.readItems()[0].stage, 'merged');

  // Two copies of one string are one entry, not two.
  assert.match(duplicate(['move', 'P1-01', 'verified', '--evidence', 'x', '--evidence', 'x', '--by', 'human:test']).stderr, /Needs at least two new pieces of evidence/);
});

// T-0068 — needs-triage described itself as a hold someone else must lift,
// yet a flagged item could be claimed and walked to verified while still
// flagged: the only thing it gated was `gw triage --approve`. Asserted as
// outcomes: the advance is REFUSED while flagged, side stages and claim stay
// open, and the same advance is ACCEPTED once another actor approves.
test('a needs-triage item is refused advancement past the initial stage, and accepted once another actor approves', () => {
  const b = board([item({ flag: 'needs-triage', created_by: 'agent:alpha' })]);
  assert.throws(
    () => run(ctx(b, ['P1-01', 'specified'], {}, 'agent:beta')),
    (error) => error instanceof RuleError
      && /needs-triage/.test(error.message)
      && /agent:alpha/.test(error.message)
      && /gw triage P1-01 --approve/.test(error.message),
    'the refusal names the flag, its creator, and the command that lifts the hold',
  );
  assert.equal(b.store.readItems()[0].stage, 'backlog', 'a refused move leaves the item where it was');

  // Discarding or parking unreviewed capture needs no ceremony: side stages stay open.
  const parked = board([item({ flag: 'needs-triage', created_by: 'agent:alpha' })]);
  run(ctx(parked, ['P1-01', 'paused']));
  assert.equal(parked.store.readItems()[0].stage, 'paused');

  // Taking responsibility for unreviewed work is harmless and a useful signal.
  const b2 = board([item({ flag: 'needs-triage', created_by: 'agent:alpha' })]);
  claim(ctx(b2, ['P1-01'], {}, 'agent:beta'));
  assert.equal(b2.store.readItems()[0].owner, 'agent:beta');

  // The hold is lifted by someone other than the creator; the same advance then succeeds.
  triage(ctx(b2, ['P1-01'], { approve: true }, 'human:reviewer'));
  assert.equal(b2.store.readItems()[0].flag, null);
  run(ctx(b2, ['P1-01', 'specified'], {}, 'agent:beta'));
  assert.equal(b2.store.readItems()[0].stage, 'specified');
});

test('--force remains the recorded override for the triage hold', () => {
  const b = board([item({ flag: 'needs-triage', created_by: 'agent:alpha' })]);
  run(ctx(b, ['P1-01', 'specified'], { force: true }, 'agent:beta'));
  assert.equal(b.store.readItems()[0].stage, 'specified');
});

// T-0083 — a parent describes the delivery as a whole; letting it reach the
// done stage while its children remain in backlog turns hierarchy into a
// cosmetic list. The stage rule refuses that shortcut, and becomes passable
// only once the direct children are terminal.
test('children_done refuses a parent with open children and accepts it once they finish', () => {
  const hierarchy = {
    stages: [{ id: 'backlog' }, { id: 'done', role: 'done', requires: { children_done: true } }],
    terminal: ['done'], extra: [],
  };
  const parent = item({ id: 'P1-01', stage: 'backlog' });
  const child = item({ id: 'P1-01.1', parent: 'P1-01', stage: 'backlog' });
  const b = board([parent, child], {}, hierarchy);

  assert.throws(
    () => run(ctx(b, ['P1-01', 'done'])),
    (error) => error instanceof RuleError && /all child items must be finished.*P1-01\.1 \(backlog\)/.test(error.failures.join('\n')),
  );
  assert.equal(b.store.readItems().find((entry) => entry.id === 'P1-01').stage, 'backlog');

  run(ctx(b, ['P1-01.1', 'done']));
  run(ctx(b, ['P1-01', 'done']));
  assert.equal(b.store.readItems().find((entry) => entry.id === 'P1-01').stage, 'done');
});

// The half of the hold that was already true and now must stay true: a
// terminal item carrying needs-triage would sit in brief's NEEDS TRIAGE list
// as finished-but-unreviewed, which is nonsense.
test('the needs-triage flag does not survive into a terminal stage', () => {
  const done = { stages: [{ id: 'todo' }, { id: 'done' }], terminal: ['done'], extra: [] };
  const b = board([item({ stage: 'todo', flag: 'needs-triage', created_by: 'agent:alpha' })], {}, done);
  run(ctx(b, ['P1-01', 'done'], { force: true }));
  const moved = b.store.readItems()[0];
  assert.equal(moved.stage, 'done');
  assert.equal(moved.flag, null);
});

// T-0072 — claim is a lock at `claim` and not at `move`: a second agent was
// refused the claim yet could move the item out from under its owner with the
// owner left on it. Asserted as outcomes: the non-owner is REFUSED, the owner
// SUCCEEDS, and --force on the move stays a deliberate one-off.
test('move respects the claim: a non-owner is refused and the owner succeeds', () => {
  const b = board([item({ stage: 'building', owner: 'agent:alpha' })]);
  assert.throws(
    () => run(ctx(b, ['P1-01', 'built'], { evidence: ['abc123'] }, 'agent:beta')),
    (error) => error instanceof RuleError
      && /owned by agent:alpha/.test(error.message)
      && /gw claim P1-01 --force/.test(error.message),
    'the refusal names the current owner and the honest way in',
  );
  assert.equal(b.store.readItems()[0].stage, 'building');
  assert.equal(b.store.readItems()[0].owner, 'agent:alpha', 'the refusal does not touch the owner');

  run(ctx(b, ['P1-01', 'built'], { evidence: ['abc123'] }, 'agent:alpha'));
  assert.equal(b.store.readItems()[0].stage, 'built', 'the owner moves their own item');

  // The one-off override stays available, exactly as claim's --force is.
  const stolen = board([item({ stage: 'building', owner: 'agent:alpha' })]);
  run(ctx(stolen, ['P1-01', 'built'], { evidence: ['abc123'], force: true }, 'agent:beta'));
  assert.equal(stolen.store.readItems()[0].stage, 'built');

  // An unowned item is unaffected: anyone may move it, subject to the gates.
  const unowned = board([item({ stage: 'backlog', owner: null })]);
  run(ctx(unowned, ['P1-01', 'specified'], {}, 'agent:beta'));
  assert.equal(unowned.store.readItems()[0].stage, 'specified');
});
