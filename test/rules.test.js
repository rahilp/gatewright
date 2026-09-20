import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageList, stageIndex, nextStage, evaluateRequires, evaluateCumulative, findCycles, missingDeps, stageOrderMessage } from '../lib/rules.js';
import { ARTIFACT_EVIDENCE } from '../lib/gates/describe.js';

const stages = { stages: [
  { id: 'backlog' }, { id: 'building', requires: { owner: true } },
  { id: 'built', requires: { evidence_min: 1, deps_at_least: 'built' } },
  { id: 'review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
], terminal: ['dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
const item = (overrides = {}) => ({ id: 'A', stage: 'backlog', owner: null, evidence: [], deps: [], ...overrides });

test('stage helpers preserve pipeline order and exclude extras from indexing', () => {
  assert.deepEqual(stageList(stages).map((stage) => stage.id), ['backlog', 'building', 'built', 'review', 'dropped', 'paused']);
  assert.equal(stageIndex(stages, 'built'), 2);
  assert.equal(stageIndex(stages, 'dropped'), -1);
  assert.equal(nextStage(stages, 'built'), 'review');
  assert.equal(nextStage(stages, 'review'), null);
});

test('owner, evidence minimum, and evidence pattern requirements pass and fail', () => {
  assert.equal(evaluateRequires(item({ owner: 'human:a' }), 'building', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item(), 'building', { items: [], stages }).failures[0], /gw claim A/);
  assert.equal(evaluateRequires(item({ evidence: [{ text: 'commit', stage: 'built' }] }), 'built', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item(), 'built', { items: [], stages }).failures.join('\n'), /evidence/);
  assert.equal(evaluateRequires(item({ evidence: [{ text: 'https://github.com/a/b/pull/1', stage: 'review' }] }), 'review', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item({ evidence: [{ text: 'commit', stage: 'review' }] }), 'review', { items: [], stages }).failures[0], /Evidence supplied with the move must include a link to a pull request/);
});

// T-0029 — the gates count what a move supplies, not the item's lifetime
// evidence array. Under the lifetime reading the final gate of the shipped
// pipeline could not fail: by `verified`, earlier stages had already recorded
// two entries, so the gate was dead code as shipped.
test('evidence gates count only entries supplied for the stage being entered', () => {
  const tagged = item({ evidence: [{ text: 'commit', stage: 'built' }, { text: 'c', stage: 'review' }] });
  assert.equal(evaluateRequires(tagged, 'built', { items: [], stages }).ok, true);
  assert.equal(evaluateRequires(item({ evidence: [{ text: 'c', stage: 'review' }] }), 'built', { items: [], stages }).ok, false, 'evidence earned at another stage does not clear this gate');
});

test('duplicates in one move count once, after trimming', () => {
  const two = { stages: [{ id: 'done', requires: { evidence_min: 2 } }], terminal: ['done'], extra: [] };
  const dupes = item({ evidence: [{ text: 'x', stage: 'done' }, { text: '  x  ', stage: 'done' }] });
  assert.equal(evaluateRequires(dupes, 'done', { items: [], stages: two }).ok, false, 'two copies of one string are one distinct entry');
  assert.equal(evaluateRequires(dupes, 'done', { items: [], stages: two, supplied: [{ text: 'x', stage: null }] }).ok, false, 'a repeat of what is already recorded is not fresh either');
});

test('a move-supplied entry that repeats recorded evidence is not fresh, so re-entering a stage demands new proof', () => {
  const recorded = [{ text: 'commit', stage: 'built' }];
  const reentering = { ...item({ stage: 'building' }), evidence: [...recorded, { text: 'commit', stage: 'built' }] };
  assert.equal(evaluateRequires(reentering, 'built', { items: [], stages, supplied: recorded }).ok, false);
  assert.equal(evaluateRequires(reentering, 'built', { items: [], stages }).ok, true, 'with no move in flight the recorded entry still stands');
});

test('migrated stage-null entries count for gates up to where the item stands, never for a gate ahead of it', () => {
  const legacy = item({ stage: 'review', evidence: [{ text: 'https://github.com/a/b/pull/1', stage: null }] });
  assert.equal(evaluateRequires(legacy, 'review', { items: [], stages }).ok, true, 'an upgraded board stays clean at the stage its evidence got it to');
  const ahead = item({ evidence: [{ text: 'https://github.com/a/b/pull/1', stage: null }] });
  assert.equal(evaluateRequires(ahead, 'review', { items: [], stages }).ok, false, 'flat strings never satisfy a gate the item is entering');
});

// T-0033 — a gate refusal names the requirement, in the same English the
// board and `gw next` already use, not just the rule key.
//
// T-0129 — and it never prints a value that would clear the gate. `--evidence
// "new evidence 1"` was literally the string the count gate then accepted, so
// the evidence rule could be satisfied by pasting the refusal back. Every
// printed value is now an angle-bracketed placeholder naming the shape.
test('an evidence refusal states the requirement in plain English, and offers a placeholder rather than a passing value', () => {
  const minimum = evaluateCumulative(item({ owner: 'human:a' }), 'built', { items: [], stages });
  assert.match(minimum.failures.join('\n'), /built: Needs at least one new piece of evidence, distinct from anything already recorded: run `gw move A built --evidence "<commit sha, test path, or URL>"`/);
  const match = evaluateCumulative(item({ owner: 'human:a' }), 'review', { items: [], stages });
  assert.match(match.failures.join('\n'), /review: Evidence supplied with the move must include a link to a pull request: run `gw move A review --evidence "<pull-request url>"`/);

  // Several still-required pieces stay distinct: the gate de-duplicates, so
  // one placeholder repeated is a command that refuses itself.
  const two = { stages: [{ id: 'done', requires: { evidence_min: 2 } }], terminal: ['done'], extra: [] };
  assert.match(
    evaluateRequires(item({ stage: 'done' }), 'done', { items: [], stages: two }).failures[0],
    /run `gw move A done --evidence "<commit sha, test path, or URL #1>" --evidence "<commit sha, test path, or URL #2>"`/,
  );

  // A stage carrying both rules prints one shape, so the filled-in command
  // clears the count and the pattern in the same move.
  const both = { stages: [{ id: 'done', requires: { evidence_min: 1, evidence_match: '^https://github.com/.+/pull/\\d+' } }], terminal: ['done'], extra: [] };
  const printed = evaluateRequires(item({ stage: 'done' }), 'done', { items: [], stages: both }).failures;
  assert.equal(printed.length, 2);
  for (const failure of printed) assert.match(failure, /--evidence "<pull-request url>"/);
});

// T-0129 — the shape gate the shipped boards put on the stage where work is
// claimed complete. Free text is what an agent pastes when it is answering the
// refusal rather than doing the work, so free text is exactly what must fail.
test('the shipped shape gate accepts a commit, a path or a link, and refuses free text', () => {
  const shape = { stages: [{ id: 'done', requires: { evidence_match: ARTIFACT_EVIDENCE } }], terminal: ['done'], extra: [] };
  const entered = (text) => evaluateRequires(item({ stage: 'done', evidence: [{ text, stage: 'done' }] }), 'done', { items: [], stages: shape }).ok;
  for (const good of ['abc1234', 'deadbeefcafe', 'test/rules.test.js', 'lib/gates/describe.js:42', 'README.md', 'https://github.com/a/b/pull/1', 'https://ci.example.test/run/12']) {
    assert.equal(entered(good), true, `${good} is an artifact reference and must pass`);
  }
  for (const bad of ['new evidence 1', 'new evidence 2', 'npm test', 'commit abc', 'it works', 'tests pass', 'abc123', 'done']) {
    assert.equal(entered(bad), false, `${bad} is free text and must not pass`);
  }
  assert.equal(
    evaluateRequires(item({ stage: 'done' }), 'done', { items: [], stages: shape }).failures[0],
    'Evidence supplied with the move must look like a commit, a file path, or a link: run `gw move A done --evidence "<commit sha, test path, or URL>"`',
    'the refusal reads back in English and offers a placeholder, never a value that would pass',
  );
});

test('dependency stage requirement accepts its boundary and rejects earlier, missing, and extra stages', () => {
  const evidence = [{ text: 'commit', stage: 'built' }];
  const subject = item({ evidence, deps: ['B'] });
  assert.equal(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'built' })], stages }).ok, true);
  assert.match(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'building' })], stages }).failures[0], /B/);
  assert.match(evaluateRequires(item({ evidence, deps: ['X'] }), 'built', { items: [], stages }).failures[0], /X/);
  assert.match(evaluateRequires(item({ evidence, deps: ['D'] }), 'built', { items: [item({ id: 'D', stage: 'dropped' })], stages }).failures[0], /D/);
});

test('a stage without requirements passes', () => assert.deepEqual(evaluateRequires(item(), 'backlog', { items: [], stages }), { ok: true, failures: [] }));

test('cumulative rules name each pipeline gate skipped by a late-stage jump', () => {
  const result = evaluateCumulative(item(), 'review', { items: [], stages });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /building: needs an owner/);
  assert.match(result.failures.join('\n'), /built: Needs at least one new piece of evidence/);
  assert.match(result.failures.join('\n'), /review: Evidence supplied with the move must include a link to a pull request/);
  assert.deepEqual(evaluateCumulative(item(), 'paused', { items: [], stages }), { ok: true, failures: [] });
});

test('findCycles deterministically finds self, two-item, and three-item cycles', () => {
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['A'] })]), [['A']]);
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['B'] }), item({ id: 'B', deps: ['A'] })]), [['A', 'B']]);
  assert.deepEqual(findCycles([item({ id: 'A', deps: ['B'] }), item({ id: 'B', deps: ['C'] }), item({ id: 'C', deps: ['A'] })]), [['A', 'B', 'C']]);
});

test('missingDeps lists missing ids by item', () => {
  assert.deepEqual(missingDeps([item({ id: 'A', deps: ['B', 'X'] }), item({ id: 'B' })]), [{ id: 'A', missing: ['X'] }]);
});

test('stageOrderMessage names the immediate next stage and the exact command, never --force', () => {
  assert.equal(
    stageOrderMessage('A', 'backlog', 'built', stages),
    'building: move here first: run `gw move A building`',
  );
});

test('stageOrderMessage names how many further stages remain when several are skipped', () => {
  assert.equal(
    stageOrderMessage('A', 'backlog', 'review', stages),
    'building: move here first (review is 2 stages beyond building): run `gw move A building`',
  );
});

test('stageOrderMessage tells a backward jump to use --force since there is no forward fix', () => {
  assert.equal(
    stageOrderMessage('A', 'built', 'backlog', stages),
    'backlog comes before built in the pipeline; moving backward needs --force: run `gw move A backlog --force`',
  );
});

// This function exists to hand back a command that works. It used to answer an
// off-pipeline stage with `gw move A backlog` -- which the very same rule
// refuses, with the very same sentence, forever. A side stage has no next
// stage, so re-entering the pipeline is a jump, and a jump is what --force is.
test('stageOrderMessage re-enters the pipeline from a side stage with a command move accepts', () => {
  assert.equal(
    stageOrderMessage('A', 'paused', 'built', stages),
    'paused is outside the pipeline, so no stage follows it; re-entering at built needs --force: run `gw move A built --force`',
  );
});

// The trunk-shaped board that found this: its last stage is the finish line,
// and leaving it reported the item as outside the pipeline it was standing in.
test('stageOrderMessage treats the last stage as in the pipeline, not outside it', () => {
  const trunk = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }], terminal: ['dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
  const message = stageOrderMessage('A', 'built', 'building', trunk);
  assert.equal(message, 'building comes before built in the pipeline; moving backward needs --force: run `gw move A building --force`');
  assert.doesNotMatch(message, /outside the pipeline/);
});

// The property that matters more than any single sentence: whatever the
// refusal tells you to run, `move` has to accept it. Checked over every
// ordered pair of stages on the shipped board, because a dead end in one
// corner of one pipeline is how this shipped in the first place.
test('every refusal names a command move would accept, from every stage to every other', () => {
  const shipped = JSON.parse(readFileSync(new URL('../templates/stages.json', import.meta.url), 'utf8'));
  const ids = [...shipped.stages, ...shipped.extra].map((stage) => stage.id);
  for (const from of ids) {
    for (const to of ids) {
      if (from === to || stageIndex(shipped, to) < 0) continue; // side targets are never order-refused
      if (nextStage(shipped, from) === to) continue;            // the lawful single step
      const message = stageOrderMessage('A', from, to, shipped);
      const command = /run `gw (move A [^`]+)`/.exec(message);
      assert.ok(command, `${from} -> ${to}: the refusal names no command: ${message}`);
      const [, argv] = command;
      const [, , target, force] = argv.split(' ');
      const accepted = force === '--force' || nextStage(shipped, from) === target;
      assert.ok(accepted, `${from} -> ${to}: move would refuse the command it just told you to run (${argv})`);
    }
  }
});
