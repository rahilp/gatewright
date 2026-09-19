// T-0113 / T-0114 — a human's bare `gw add` is flagged `unclassified`, not
// `needs-triage`. The flag keeps the item off the scheduler and in the triage
// inbox until it is classified or approved, and nothing else: claim and move
// ignore it. The agent policy hold (needs-triage) is unchanged. Boards written
// by an older gw carry needs-triage on those captures, and `gw repair` releases
// them.
import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run as add } from '../lib/commands/add.js';
import { run as claim } from '../lib/commands/claim.js';
import { run as edit } from '../lib/commands/edit.js';
import { run as move } from '../lib/commands/move.js';
import { run as triage } from '../lib/commands/triage.js';
import { run as check } from '../lib/commands/check.js';
import { computeBuckets } from '../lib/brief.js';
import { isSchedulable } from '../lib/policy.js';
import { persistConfigAndReleaseTriageHolds } from '../lib/triage-policy.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = {
  stages: [{ id: 'backlog', role: 'initial' }, { id: 'building', requires: { owner: true } }, { id: 'done', role: 'done' }],
  terminal: ['done', 'dropped'],
  extra: [{ id: 'dropped', role: 'dropped' }],
};
const item = (over = {}) => ({
  id: 'T-0001', title: 'captured', stage: 'backlog', owner: null, flag: 'unclassified', phase: null, type: null, priority: null,
  deps: [], evidence: [], created_by: 'human:me', updated: new Date().toISOString(), ...over,
});

function board(items = [], config = { id_scheme: 'seq', policy: { triage_required_for: ['agent'] } }) {
  const root = mkdtempSync(join(tmpdir(), 'gw-unclassified-'));
  const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify(config));
  store.writeItems(items); store.rebaselineDigest();
  return { root, store };
}
function ctx(b, actor, positionals = ['T-0001'], flags = {}) {
  let output = '';
  return { output: () => output, ctx: { store: b.store, root: b.root, actor, positionals, flags, env: {}, stdout: { write(s) { output += s; } }, stderr: { write(s) { output += s; } } } };
}
const flagOf = (b, id = 'T-0001') => b.store.readItems().find((entry) => entry.id === id)?.flag;

test('a human bare add is unclassified: off the scheduler, but claimed and moved with no triage step', () => {
  const b = board();
  add(ctx(b, 'human:me', ['Fix the login bug']).ctx);
  const created = b.store.readItems()[0];
  assert.equal(created.flag, 'unclassified');
  assert.equal(isSchedulable(created, { config: {}, stages, items: [created] }), false);
  const claimed = ctx(b, 'human:me');
  claim(claimed.ctx);
  assert.equal(claimed.output(), '', 'no hold to warn about');
  move(ctx(b, 'human:me', ['T-0001', 'building']).ctx);
  assert.equal(b.store.readItems()[0].stage, 'building');
});

test('the agent policy hold still wins over the capture flag, and move still refuses it', () => {
  const b = board();
  add(ctx(b, 'agent:maker', ['agent capture']).ctx);
  assert.equal(flagOf(b), 'needs-triage');
  add(ctx(b, 'human:me', ['classified'], { priority: 'high' }).ctx);
  assert.equal(flagOf(b, 'T-0002'), null, 'a classified human capture carries no flag');
  const humanHeld = board([], { id_scheme: 'seq', policy: { triage_required_for: ['human'] } });
  add(ctx(humanHeld, 'human:me', ['held by policy']).ctx);
  assert.equal(flagOf(humanHeld), 'needs-triage', 'a policy covering humans still holds a human capture');
  claim(ctx(b, 'agent:maker').ctx);
  assert.throws(() => move(ctx(b, 'agent:maker', ['T-0001', 'building']).ctx), /held for triage/);
});

test('classifying an unclassified item clears the flag; classifying a held item does not', () => {
  const b = board([item(), item({ id: 'T-0002', flag: 'needs-triage', created_by: 'agent:maker' })]);
  edit(ctx(b, 'human:me', ['T-0001'], { priority: 'high' }).ctx);
  assert.equal(flagOf(b), null);
  assert.deepEqual(b.store.readEvents().at(-1), { ...b.store.readEvents().at(-1), type: 'edit', flag: null, reason: 'classified' });
  edit(ctx(b, 'human:me', ['T-0002'], { priority: 'high' }).ctx);
  assert.equal(flagOf(b, 'T-0002'), 'needs-triage', 'only gw triage lifts the policy hold');
});

test('the creator may approve their own unclassified capture as is', () => {
  const b = board([item()]);
  triage(ctx(b, 'human:me', ['T-0001'], { approve: true }).ctx);
  assert.equal(flagOf(b), null);
});

test('the inbox lists both flags and says which one can be worked', () => {
  const b = board([item(), item({ id: 'T-0002', flag: 'needs-triage', created_by: 'agent:maker' })]);
  const state = { items: b.store.readItems(), events: [], stages };
  assert.deepEqual(computeBuckets(state).triage.map((entry) => entry.id), ['T-0001', 'T-0002']);
  const result = ctx(b, 'human:test', []);
  assert.equal(check(result.ctx), 0);
  assert.match(result.output(), /^INBOX — 2 items waiting for triage \(1 not classified yet, 1 held for review\)\. Not a violation/m);
  assert.match(result.output(), /T-0001: it can be worked now/);
  assert.match(result.output(), /T-0002: run `gw triage T-0002 --approve` to clear the hold/);
});

test('lifting a policy hold leaves an unclassified human capture flagged unclassified', () => {
  const b = board([item({ flag: 'needs-triage' }), item({ id: 'T-0002', flag: 'needs-triage', priority: 'high' })], { policy: { triage_required_for: ['human'] } });
  const previousConfig = { policy: { triage_required_for: ['human'] } };
  persistConfigAndReleaseTriageHolds(b.store, { previousConfig, config: { policy: { triage_required_for: [] } }, actor: 'human:me' });
  assert.equal(flagOf(b), 'unclassified');
  assert.equal(flagOf(b, 'T-0002'), null);
});

// T-0114 — the claim message named the wrong approver: a human may approve
// their own capture; only an agent cannot approve its own.
test('the claim message names who may actually approve the hold', () => {
  const human = board([item({ flag: 'needs-triage', created_by: 'human:me' })]);
  const byCreator = ctx(human, 'human:me'); claim(byCreator.ctx);
  assert.match(byCreator.output(), /held for triage: run `gw triage T-0001 --approve` to clear the hold/);
  assert.doesNotMatch(byCreator.output(), /someone other than its creator/);

  const agent = board([item({ flag: 'needs-triage', created_by: 'agent:maker' })]);
  const ownAgent = ctx(agent, 'agent:maker'); claim(ownAgent.ctx);
  assert.match(ownAgent.output(), /held for triage: you cannot approve your own item/);

  const other = board([item({ flag: 'needs-triage', created_by: 'agent:maker' })]);
  const otherAgent = ctx(other, 'agent:reviewer'); claim(otherAgent.ctx);
  assert.match(otherAgent.output(), /held for triage: run `gw triage T-0001 --approve`/);
});

test('check counts stale triage flags with the right verb', () => {
  const two = board([item({ stage: 'done', owner: 'human:me', flag: 'needs-triage' }), item({ id: 'T-0002', stage: 'done', owner: 'human:me', flag: 'unclassified' })]);
  const result = ctx(two, 'human:test', []);
  assert.equal(check(result.ctx), 0);
  assert.match(result.output(), /^STALE TRIAGE HOLD — 2 finished items still carry a triage flag\. Not a violation; run `gw repair --write` to tidy them up\.$/m);
  assert.match(result.output(), /T-0002: finished in done with the unclassified flag, which no longer needs action/);
});

function cli(root, args) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GW_ACTOR: 'human:tester' } });
}

test('a pre-0.13 capture hold is reported by check and released by repair; agent holds stay', () => {
  const b = board([
    item({ flag: 'needs-triage' }),
    item({ id: 'T-0002', flag: 'needs-triage', type: 'bug' }),
    item({ id: 'T-0003', flag: 'needs-triage', created_by: 'agent:maker' }),
    item({ id: 'T-0004', flag: 'needs-triage', created_by: undefined }),
  ]);
  const report = ctx(b, 'human:test', []);
  assert.equal(check(report.ctx), 0);
  assert.match(report.output(), /^OLD CAPTURE HOLD — 2 unclassified items are still held the way gw before 0\.13 held every unclassified capture\. Not a violation; run `gw repair --write` to release them\.$/m);
  assert.match(report.output(), /INBOX — 2 items held for review/, 'the agent hold and the unattributed hold stay in the inbox');

  const dry = cli(b.root, ['repair']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Found 2 pre-0\.13 capture holds\. Dry run — nothing changed\. Run again with --write to clear them/);
  assert.equal(flagOf(b), 'needs-triage');

  const write = cli(b.root, ['repair', '--write']);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /released 2 pre-0\.13 capture holds, so those items can be worked now/);
  assert.equal(flagOf(b), 'unclassified', 'still unclassified: it stays in the inbox');
  assert.equal(flagOf(b, 'T-0002'), null, 'classified since: nothing left to flag');
  assert.equal(flagOf(b, 'T-0003'), 'needs-triage', 'the agent policy hold is untouched');
  assert.equal(flagOf(b, 'T-0004'), 'needs-triage', 'an unattributed hold cannot be told apart from a policy hold');
  const moved = cli(b.root, ['move', 'T-0001', 'building', '--by', 'human:me']);
  assert.equal(moved.status, 1, 'moving needs an owner, not a triage approval');
  assert.doesNotMatch(moved.stderr, /triage/);
});

test('repair states a single tidy-up in the singular', () => {
  const b = board([item({ stage: 'done', flag: 'needs-triage' })]);
  const dry = cli(b.root, ['repair']);
  assert.match(dry.stdout, /Found 1 stale triage hold on finished work\. Dry run — nothing changed\. Run again with --write to clear it and record flag events\./);
  const write = cli(b.root, ['repair', '--write']);
  assert.match(write.stdout, /Repaired: cleared 1 stale triage hold from finished work; recorded flag events\./);
});
