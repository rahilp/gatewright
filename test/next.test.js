import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/next.js';
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
  return { root, store };
}
function ctx(b, positionals, flags = {}) {
  let out = '';
  return { flags, positionals, store: b.store, root: b.root, actor: 'human:test', env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, get out() { return out; } };
}

test('gw next rejects an unknown item', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['nope'])), UsageError);
});

test('gw next on a fresh item names specified as reachable and lists side stages, and names the next stage for everything blocked by order', () => {
  const b = board();
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.equal(c.out, `P1-01  stage: backlog

can move to now:
  specified: run \`gw move P1-01 specified\`
  dropped: run \`gw move P1-01 dropped\`
  paused: run \`gw move P1-01 paused\`

cannot move to yet:
  building:
    - specified: move here first: run \`gw move P1-01 specified\`
    - Someone must have claimed it
  built:
    - specified: move here first (built is 2 stages beyond specified): run \`gw move P1-01 specified\`
    - Someone must have claimed it
    - Needs at least one piece of evidence
  in_review:
    - specified: move here first (in_review is 3 stages beyond specified): run \`gw move P1-01 specified\`
    - Someone must have claimed it
    - Needs at least one piece of evidence
    - Evidence must include a link to a pull request
  reviewed:
    - specified: move here first (reviewed is 4 stages beyond specified): run \`gw move P1-01 specified\`
    - Someone must have claimed it
    - Needs at least one piece of evidence
    - Evidence must include a link to a pull request
  merged:
    - specified: move here first (merged is 5 stages beyond specified): run \`gw move P1-01 specified\`
    - Someone must have claimed it
    - Needs at least one piece of evidence
    - Evidence must include a link to a pull request
  verified:
    - specified: move here first (verified is 6 stages beyond specified): run \`gw move P1-01 specified\`
    - Someone must have claimed it
    - Needs at least one piece of evidence
    - Evidence must include a link to a pull request
    - Needs at least two pieces of evidence
`);
});

test('gw next --json matches the shape of the live board\'s /transitions endpoint', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  const c = ctx(b, ['P1-01'], { json: true });
  run(c);
  const parsed = JSON.parse(c.out);
  assert.equal(parsed.id, 'P1-01');
  assert.equal(parsed.stage, 'building');
  assert.deepEqual(parsed.transitions.built, { ok: false, failures: ['built: needs at least 1 evidence entry: run `gw move P1-01 built --evidence <e>`'], reasons: ['Needs at least one piece of evidence'] });
  assert.deepEqual(parsed.transitions.specified, { ok: true, failures: [], force: true });
});

test('gw next on a terminal item explains that leaving needs --force, not an unmet rule', () => {
  const b = board([item({ stage: 'verified', evidence: ['a', 'b'] })]);
  const c = ctx(b, ['P1-01']);
  run(c);
  assert.match(c.out, /verified is a terminal stage; leaving it needs --force: run `gw move P1-01 dropped --force`/);
  assert.match(c.out, /verified is a terminal stage; leaving it needs --force: run `gw move P1-01 paused --force`/);
});
