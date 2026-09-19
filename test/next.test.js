import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/next.js';
import { describeRule } from '../lib/gates/describe.js';
import { UsageError } from '../lib/cli/errors.js';

const stages = {
  stages: [
    { id: 'backlog' }, { id: 'specified' }, { id: 'building', requires: { owner: true } },
    { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
    { id: 'reviewed' }, { id: 'merged' }, { id: 'verified', requires: { evidence_min: 2 } },
  ], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }],
};
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', flag: null, owner: null, deps: [], evidence: [], updated: '2020-01-01T00:00:00.000Z', gh: null, ...over });

function board(items = [item()]) {
  const root = mkdtempSync(join(tmpdir(), 'gw-next-'));
  const store = createStore(root); store.ensure(); store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({}));
  // These fixture writes are legitimate setup, not a hand edit under test.
  store.rebaselineDigest();
  return { root, store };
}
function ctx(b, positionals, flags = {}, actor = 'human:test') {
  let out = '';
  return { flags, positionals, store: b.store, root: b.root, actor, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, get out() { return out; } };
}

test('gw next rejects an unknown item', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['nope'])), UsageError);
});

test('gw next on a fresh item leads with the immediate next stage and keeps side moves secondary', () => {
  const b = board();
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.equal(c.out, `P1-01  stage: backlog

next: specified (ready): run \`gw move P1-01 specified\`

other moves: dropped, paused (now)
`);
});

test('gw next mid-pipeline leads with the blocked next stage, collapses further stages to a count, and puts backward moves in their own section after the answer', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  const c = ctx(b, ['P1-01']);
  run(c);
  // The gate sentence comes from lib/gates/describe.js; the structure around
  // it — answer first, dep and count beneath, side moves last — is what this
  // test pins.
  assert.equal(c.out, `P1-01  stage: building

next: built (blocked)
  - ${describeRule('evidence_min', 1, stages)}
  - 4 further stages need this first

other moves: dropped, paused (now); backlog, specified (needs --force)
`);

  const answerLine = c.out.indexOf('next: built');
  const backwardLine = c.out.indexOf('backlog, specified (needs --force)');
  assert.ok(answerLine >= 0 && backwardLine > answerLine, 'the answer must appear before the backward/side moves section');
});

// T-0045 — the gate sentences name conditions, never the item causing them,
// so an item stuck behind a dependency was told "someone must have claimed
// it" and never which dependency was in the way. next must name it, the way
// the brief's BLOCKED section does.
test('gw next names the dependency that is in the way', () => {
  const dep = { ...item(), id: 'P1-02', stage: 'dropped' };
  const b = board([item({ stage: 'specified', deps: ['P1-02'] }), dep]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.match(c.out, /next: building \(blocked\)/);
  assert.match(c.out, /  - Someone must have claimed it/);
  assert.match(c.out, /  - waiting on P1-02 \(dropped\)/);
});

test('gw next stays quiet about dependencies when none is in the way', () => {
  const dep = { ...item(), id: 'P1-02' };
  const b = board([item({ deps: ['P1-02'] }), dep]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.doesNotMatch(c.out, /waiting on/);
});

test('gw next names a triage hold before its generic unmet gate reasons without telling its creator to self-approve', () => {
  const b = board([item({ stage: 'specified', flag: 'needs-triage', created_by: 'agent:maker' })]);
  const c = ctx(b, ['P1-01'], {}, 'agent:maker');
  run(c);
  assert.match(c.out, /next: building \(blocked\)/);
  assert.match(c.out, /  - held for triage: you cannot approve your own item; run `gw triage P1-01 --drop`/);
  assert.doesNotMatch(c.out, /--approve/);
  assert.ok(c.out.indexOf('held for triage') < c.out.indexOf('Someone must have claimed it'), 'the actual policy blocker is named first');
});

// T-0073 — "waiting on T-0002 (dropped)" used to be the one failure state in
// the product that printed no command: the user had to guess
// `gw edit <id> --deps ""`, which would also wipe every other dependency.
// The advice must name the edit that removes exactly the stranded deps.
test('gw next names the edit that drops a stranded dependency and keeps the live ones', () => {
  const dep = { ...item(), id: 'P1-02', stage: 'dropped' };
  const other = { ...item(), id: 'P1-03', stage: 'specified' };
  const b = board([item({ stage: 'specified', deps: ['P1-02', 'P1-03'] }), dep, other]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.match(c.out, /  - waiting on P1-02 \(dropped\)/);
  assert.match(c.out, /  - it cannot advance: run `gw edit P1-01 --deps P1-03` to remove it from the deps/);
  assert.doesNotMatch(c.out, /--deps ""/, 'the live dependency P1-03 must survive the advised edit');
});

test('gw next advises --deps "" only when the stranded dependency was the last one', () => {
  const dep = { ...item(), id: 'P1-02', stage: 'dropped' };
  const b = board([item({ stage: 'specified', deps: ['P1-02'] }), dep]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.match(c.out, /  - it cannot advance: run `gw edit P1-01 --deps ""` to remove it from the deps/);
});

test('gw next stays quiet about a stranded-dep edit when the dependency is merely behind', () => {
  const dep = { ...item(), id: 'P1-02', stage: 'backlog' };
  const b = board([item({ stage: 'specified', deps: ['P1-02'] }), dep]);
  const c = ctx(b, ['P1-01']);
  run(c);
  // A dep that can still move is not stranded: the gate refusal already
  // names `gw move` for it, and the edit would be the wrong advice.
  assert.doesNotMatch(c.out, /cannot advance/);
});

test('gw next --json matches the shape of the live board\'s /transitions endpoint', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  const c = ctx(b, ['P1-01'], { json: true });
  run(c);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.id, 'P1-01');
  assert.equal(parsed.stage, 'building');
  // The gate wording belongs to lib/rules.js and lib/gates/describe.js; this
  // test pins the shape: the machine failure names the stage, the human
  // reasons carry describe.js's sentence for the same rule.
  const built = parsed.transitions.built;
  assert.equal(built.ok, false);
  assert.equal(built.failures.length, 1);
  assert.match(built.failures[0], /^built: .+evidence/i);
  assert.deepEqual(built.reasons, [describeRule('evidence_min', 1, stages)]);
  assert.deepEqual(parsed.transitions.specified, { ok: true, failures: [], force: true });
});

test('gw next on a terminal item gives one explanation for leaving, not one per side stage', () => {
  const b = board([item({ stage: 'verified', evidence: ['a', 'b'] })]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.equal(c.out, `P1-01  stage: verified

verified is a terminal stage; leaving it needs --force.

other moves: dropped, paused (needs --force)
`);
});
