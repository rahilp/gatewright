import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stageList, stageIndex, nextStage, evaluateRequires, evaluateCumulative, findCycles, missingDeps, stageOrderMessage } from '../lib/rules.js';

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
  assert.equal(evaluateRequires(item({ evidence: ['commit'] }), 'built', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item(), 'built', { items: [], stages }).failures.join('\n'), /evidence/);
  assert.equal(evaluateRequires(item({ evidence: ['https://github.com/a/b/pull/1'] }), 'review', { items: [], stages }).ok, true);
  assert.match(evaluateRequires(item({ evidence: ['commit'] }), 'review', { items: [], stages }).failures[0], /evidence/);
});

test('dependency stage requirement accepts its boundary and rejects earlier, missing, and extra stages', () => {
  const subject = item({ evidence: ['commit'], deps: ['B'] });
  assert.equal(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'built' })], stages }).ok, true);
  assert.match(evaluateRequires(subject, 'built', { items: [item({ id: 'B', stage: 'building' })], stages }).failures[0], /B/);
  assert.match(evaluateRequires(item({ evidence: ['commit'], deps: ['X'] }), 'built', { items: [], stages }).failures[0], /X/);
  assert.match(evaluateRequires(item({ evidence: ['commit'], deps: ['D'] }), 'built', { items: [item({ id: 'D', stage: 'dropped' })], stages }).failures[0], /D/);
});

test('a stage without requirements passes', () => assert.deepEqual(evaluateRequires(item(), 'backlog', { items: [], stages }), { ok: true, failures: [] }));

test('cumulative rules name each pipeline gate skipped by a late-stage jump', () => {
  const result = evaluateCumulative(item(), 'review', { items: [], stages });
  assert.equal(result.ok, false);
  assert.match(result.failures.join('\n'), /building: needs an owner/);
  assert.match(result.failures.join('\n'), /built: needs at least 1 evidence/);
  assert.match(result.failures.join('\n'), /review: needs matching evidence/);
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
