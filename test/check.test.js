import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/check.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = { stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building', requires: { owner: true } }, { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } }, { id: 'reviewed' }, { id: 'merged' }, { id: 'verified', requires: { evidence_min: 2 } }], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', owner: null, deps: [], evidence: [], updated: new Date().toISOString(), gh: null, flag: null, ...over });
// `config` is merged into the check block; `vocab` is top level, because that
// is where readConfig looks for it.
function board(items = [item()], { stages: boardStages = stages, config = {}, vocab } = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-check-')); const store = createStore(root); store.ensure(); store.writeItems(items); writeFileSync(store.paths.stages, JSON.stringify(boardStages)); writeFileSync(store.paths.config, JSON.stringify({ check: { stale_days: 7, stale_exempt_stages: ['merged'], ...config }, ...(vocab ? { vocab } : {}) })); // The fixture writes stages.json and config.json by hand to stand up the board; a real board reaches this state through gw, which re-baselines the digest. Baseline here too, so only deliberate tampering in a test is ever reported.
 store.rebaselineDigest(); return { root, store }; }
function ctx(b, flags = {}) { let output = ''; return { output: () => output, ctx: { flags, positionals: [], store: b.store, root: b.root, actor: 'human:test', env: {}, stdout: { write(s) { output += s; } }, stderr: { write(s) { output += s; } } } }; }

test('check reports an out-of-band edit once then rebaselines it', () => {
  const b = board(); writeFileSync(b.store.paths.items, JSON.stringify(item({ title: 'hand edit' })) + '\n');
  const first = ctx(b); assert.equal(run(first.ctx), 1); assert.match(first.output(), /items\.jsonl modified outside gw since/);
  const second = ctx(b); assert.equal(run(second.ctx), 0); assert.match(second.output(), /clean/i);
});

test('check silently baselines an unknown digest', () => {
  const b = board(); rmSync(b.store.paths.digest);
  const result = ctx(b); assert.equal(run(result.ctx), 0); assert.doesNotMatch(result.output(), /digest|modified/i); assert.equal(b.store.verifyDigest().status, 'clean');
});

// T-0002: stages.json DEFINES the gates, so deleting a `requires` block by hand
// must be reported, not greeted with "Board is clean."
test('check reports a hand edit to stages.json, then re-baselines it', () => {
  const b = board();
  const tampered = JSON.parse(JSON.stringify(stages));
  delete tampered.stages.find((stage) => stage.id === 'built').requires;
  writeFileSync(b.store.paths.stages, JSON.stringify(tampered));
  const first = ctx(b); assert.equal(run(first.ctx), 1);
  assert.match(first.output(), /OUT-OF-BAND WRITE\n  stages\.json modified outside gw since /);
  const second = ctx(b); assert.equal(run(second.ctx), 0);
  assert.match(second.output(), /^Board is clean\.$/m);
});

test('check reports a hand edit to config.json in the same style', () => {
  const b = board();
  const tampered = JSON.parse(readFileSync(b.store.paths.config, 'utf8'));
  tampered.check.stale_days = 9999;
  writeFileSync(b.store.paths.config, JSON.stringify(tampered));
  const first = ctx(b); assert.equal(run(first.ctx), 1);
  assert.match(first.output(), /OUT-OF-BAND WRITE\n  config\.json modified outside gw since /);
  const second = ctx(b); assert.equal(run(second.ctx), 0);
  assert.match(second.output(), /^Board is clean\.$/m);
});

// The event log is append-only; appending is normal operation, so it must
// never be reported as tampering.
test('check does not report an appended events.jsonl line', () => {
  const b = board();
  b.store.appendEvent({ type: 'note', item: 'P1-01', by: 'human:test' });
  const result = ctx(b); assert.equal(run(result.ctx), 0);
  assert.equal(result.output(), 'Board is clean.\n');
});

test('check validates stages before examining items and keeps validation JSON machine-readable', () => {
  const b = board([item({ stage: 'building' })], {
    stages: { stages: [{ id: 'backlog', role: 'not-a-role' }], terminal: ['missing'], extra: [] },
  });
  const text = ctx(b);
  assert.equal(run(text.ctx), 1);
  assert.match(text.output(), /^STAGE DEFINITION\n/m);
  assert.match(text.output(), /role "not-a-role" is invalid/);
  assert.match(text.output(), /terminal "missing" does not name a stage/);
  assert.doesNotMatch(text.output(), /CURRENT STAGE RULE|out-of-band/i);

  const json = ctx(b, { json: true });
  assert.equal(run(json.ctx), 1);
  const problems = JSON.parse(json.output()).problems;
  assert.ok(problems.every((entry) => entry.type === 'stage definition'));
});

test('check catches a hand-placed verified item with no evidence', () => {
  const b = board();
  writeFileSync(b.store.paths.items, JSON.stringify(item({ stage: 'verified', evidence: [] })) + '\n');
  const result = ctx(b);
  assert.equal(run(result.ctx), 1);
  assert.match(result.output(), /items\.jsonl modified outside gw since/);
  assert.match(result.output(), /CURRENT STAGE RULE[\s\S]*P1-01[\s\S]*Needs at least two new pieces of evidence/i);
});

// T-0039 — the wording is the point, and so is the follow-through: the
// printed command has to actually clear the flag. `gw edit` and `gw claim`
// never did -- needs-triage is a hold on unreviewed work, and only `gw
// triage` lifts it, so the advice names triage and nothing else.
test('check reports an untriaged item, naming the triage fix that actually works', () => {
  const b = board([item({ flag: 'needs-triage' })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 0, 'reported, but capturing an idea is not a violation');
  assert.match(result.output(), /INBOX/);
  assert.match(result.output(), /P1-01: run `gw triage P1-01 --approve` to clear the hold, or `gw triage P1-01 --drop` to discard it/);
  assert.doesNotMatch(result.output(), /gw edit P1-01|gw claim P1-01/, 'the dead-end advice must be gone');
});

test('following the printed triage command ends the report', () => {
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: new Date().toISOString() })]);
  execFileSync(process.execPath, [BIN, 'triage', 'T-0001', '--approve'], { cwd: b.root });
  const after = ctx(b);
  assert.equal(run(after.ctx), 0);
  assert.equal(after.output(), 'Board is clean.\n', 'the advice check prints must leave the board clean when followed');
});

test('check does not report a classified item as needing triage', () => {
  const b = board([item({ flag: null })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 0);
  assert.equal(result.output(), 'Board is clean.\n');
});

test('check does not report a legitimately verified item with two evidence entries', () => {
  const b = board([item({ stage: 'verified', owner: 'human:test', evidence: ['abc123', 'https://github.com/a/b/pull/1'] })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 0);
  assert.equal(result.output(), 'Board is clean.\n');
});

test('check does not report a terminal merged item as stale', () => {
  const staleMerged = item({ stage: 'merged', owner: 'human:test', evidence: ['abc123', 'https://github.com/a/b/pull/1'], updated: '2020-01-01T00:00:00.000Z' });
  const b = board([staleMerged]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 0);
  assert.equal(result.output(), 'Board is clean.\n');

  const active = board([staleMerged], { config: { stale_exempt_stages: [] } });
  const activeResult = ctx(active);
  assert.equal(run(activeResult.ctx), 1);
  assert.match(activeResult.output(), /STALE OWNER[\s\S]*P1-01/);

  const customStages = {
    stages: [{ id: 'queued' }, { id: 'shipped' }],
    terminal: [],
    extra: [],
  };
  const staleShipped = item({ stage: 'shipped', owner: 'human:test', updated: '2020-01-01T00:00:00.000Z' });
  const exempt = board([staleShipped], {
    stages: customStages,
    config: { stale_exempt_stages: ['shipped'] },
  });
  assert.equal(run(ctx(exempt).ctx), 0);

  const customActive = board([staleShipped], {
    stages: customStages,
    config: { stale_exempt_stages: [] },
  });
  const customResult = ctx(customActive);
  assert.equal(run(customResult.ctx), 1);
  assert.match(customResult.output(), /STALE OWNER[\s\S]*P1-01/);
});

test('check catches a hand-edited merged item that skipped the built evidence gate', () => {
  const b = board([item({ stage: 'merged' })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 1);
  assert.match(result.output(), /CURRENT STAGE RULE[\s\S]*P1-01[\s\S]*built: Needs at least one new piece of evidence/i);
});

test('check groups current-stage, missing-dependency, cycle, dropped-dependency, stale, and conflict findings', () => {
  const old = '2020-01-01T00:00:00.000Z';
  const b = board([
    item({ id: 'bad-stage', stage: 'building' }), item({ id: 'missing', deps: ['none'] }),
    item({ id: 'cycle-a', deps: ['cycle-b'] }), item({ id: 'cycle-b', deps: ['cycle-a'] }),
    item({ id: 'dropped-dep', deps: ['gone'] }), item({ id: 'gone', stage: 'dropped' }),
    item({ id: 'stale', owner: 'human:test', updated: old }), item({ id: 'conflict', flag: 'conflict' }),
  ]);
  const result = ctx(b); assert.equal(run(result.ctx), 1);
  for (const id of ['bad-stage', 'missing', 'cycle-a', 'dropped-dep', 'stale', 'conflict']) assert.match(result.output(), new RegExp(id));
  assert.match(result.output(), /CURRENT STAGE|MISSING DEPENDENC|DEPENDENCY CYCLE|DROPPED DEPENDENC|STALE|CONFLICT/i);
  assert.match(result.output(), /gw note stale "<note>".*gw release stale/);
  assert.match(result.output(), /resolve the linked GitHub issue, then run `gw check`/);
});

test('check --json is machine-readable and the real binary exits 1 for violations', () => {
  const b = board([item({ stage: 'building' })]); const result = ctx(b, { json: true });
  assert.equal(run(result.ctx), 1); assert.ok(Array.isArray(JSON.parse(result.output()).problems));
  assert.throws(() => execFileSync(process.execPath, [BIN, 'check'], { cwd: b.root, encoding: 'utf8' }), (error) => error.status === 1);
});

test('check refuses a literal memory token and tells the user to use token_env', () => {
  const b = board([item()]);
  writeFileSync(b.store.paths.config, JSON.stringify({ check: { stale_days: 7, stale_exempt_stages: ['merged'] }, memory: { enabled: true, provider: 'second-brain', providers: { 'second-brain': { token: 'not-in-git' } } } }));
  const result = ctx(b); assert.equal(run(result.ctx), 1);
  assert.match(result.output(), /literal memory token/i); assert.match(result.output(), /environment variable/i); assert.match(result.output(), /token_env/);
});

// Vocabulary was enforced only at creation time, so a direct file write, an
// import, or simply narrowing a vocabulary later left items holding values the
// config no longer allows -- and check reported the board clean. This repo's
// own board carried 33 such items while claiming to be clean.
test('check reports items holding values the vocabulary no longer allows', () => {
  const b = board([
    item({ id: 'P1-01', priority: 'P4' }),
    item({ id: 'P1-02', priority: 'P4' }),
    item({ id: 'P1-03', priority: 'P1' }),
    item({ id: 'P1-04', type: 'chore' }),
  ], { vocab: { priority: ['P0', 'P1'], type: ['feature', 'defect'] } });
  const result = ctx(b);
  assert.equal(run(result.ctx), 1);
  assert.match(result.output(), /VOCABULARY/);
  // Grouped by value, not one line per item: 33 near-identical lines would
  // bury every other finding in the report.
  assert.match(result.output(), /2 items have priority "P4"/);
  assert.doesNotMatch(result.output(), /1 item have |items has /, 'the count and the verb must agree');
  // Asserted exactly, not as an either/or. The first version of this accepted
  // both spellings, which is how "1 item have type" reached a published
  // release: a test that tolerates two answers checks neither.
  assert.match(result.output(), /1 item has type "chore"/);
  assert.doesNotMatch(result.output(), /P1-01|P1-02/, 'items are counted, not enumerated');
  // Both remedies, because only the user knows whether the vocabulary is too
  // narrow or the items are wrong.
  assert.match(result.output(), /gw config vocab\.priority "P0,P1,P4"/);
  assert.match(result.output(), /gw edit <id> --priority <value>/);
});

// P0-15 removed the item field `gate` entirely, with no migration: `gw
// upgrade` promises data files stay byte-identical, and the tool has no users
// yet beyond one board migrated by hand. An item that still carries a legacy
// `gate` key on disk (from before the field was removed) must be completely
// inert to `check` -- gate is no longer a vocabulary field, so nothing
// evaluates it, and the board reports clean.
test('check tolerates a legacy gate key on disk and never reports it as drift', () => {
  const b = board([
    item({ id: 'P1-01', gate: 'G0' }),
    item({ id: 'P1-02', gate: 'not-even-in-the-old-vocab' }),
  ], { vocab: { priority: ['P0', 'P1'], type: ['feature', 'defect'] } });
  const result = ctx(b);
  assert.equal(run(result.ctx), 0, 'a legacy gate key must not fail the board');
  assert.doesNotMatch(result.output(), /gate/i, 'gate is no longer a vocabulary field, so check never mentions it');
});

test('a null field and an unconfigured vocabulary are not drift', () => {
  const b = board([
    item({ id: 'P1-01', priority: null, type: null }),
    item({ id: 'P1-02', priority: 'anything' }),
  ], { vocab: { type: ['feature'] } });
  const result = ctx(b);
  assert.equal(run(result.ctx), 0, 'an absent value is not a wrong value, and a vocabulary nobody configured constrains nothing');
  assert.match(result.output(), /clean/i);
});

// `gw check` runs in CI (.github/workflows/gatewright.yml). If a bare capture
// failed it, jotting an idea would break the build and you would have to
// classify it before you could commit — exactly the ceremony that one-command
// capture exists to remove. An inbox is not a defect.
test('a freshly captured untriaged item is reported but does not fail the check', () => {
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: new Date().toISOString() })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 0, 'capturing an idea must not break a build');
  assert.match(result.output(), /INBOX — 1 item not classified yet/);
  assert.doesNotMatch(result.output(), /NEEDS TRIAGE/, 'a fresh capture is not a violation');
});

// A rotting inbox is a different thing.
test('an item left untriaged past stale_days becomes a violation', () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: old })]);
  const result = ctx(b);
  assert.equal(run(result.ctx), 1);
  assert.match(result.output(), /NEEDS TRIAGE/);
  assert.match(result.output(), /untriaged for over 7 days/);
});

test('json output carries notes separately from problems', () => {
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: new Date().toISOString() })]);
  const result = ctx(b, { json: true });
  assert.equal(run(result.ctx), 0);
  const parsed = JSON.parse(result.output());
  assert.equal(parsed.problems.length, 0, 'an inbox entry is not a problem');
  assert.equal(parsed.notes.length, 1, 'but it is still reported to anything reading json');
});

// T-0019 — a dispatch queued while runner.enabled is false can never run:
// nothing will ever record the run_ended that would clear it, so the item
// sits in "queued · no agent run yet" forever. A queued dispatch is a
// legitimate choice, but only as a visible one, so it is reported as a note
// beside the inbox rather than failing the board.
test('a queued dispatch with the runner disabled is reported as a note, not a violation', () => {
  const b = board([item()]);
  b.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  const result = ctx(b);
  assert.equal(run(result.ctx), 0, 'a stranded dispatch is a report, not a failure');
  assert.equal(
    result.output(),
    'QUEUED DISPATCH — 1 dispatch no agent will ever run while the runner is disabled.\n'
    + '  P1-01: queued while runner.enabled is false, so no agent will ever pick it up: enable it with `gw config runner.enabled true` and start the scheduler with `gw serve`, or cancel the dispatch from the board\n',
  );
});

test('an ended or cancelled dispatch is not reported, and an enabled runner is not reported', () => {
  const ended = board([item()]);
  ended.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  ended.store.appendEvent({ type: 'run_ended', item: 'P1-01', by: 'scheduler' });
  const endedResult = ctx(ended);
  assert.equal(run(endedResult.ctx), 0);
  assert.equal(endedResult.output(), 'Board is clean.\n');

  const cancelled = board([item()]);
  cancelled.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  cancelled.store.appendEvent({ type: 'cancel', item: 'P1-01', by: 'human:test' });
  const cancelledResult = ctx(cancelled);
  assert.equal(run(cancelledResult.ctx), 0);
  assert.equal(cancelledResult.output(), 'Board is clean.\n');

  const enabled = board([item()]);
  // The board() helper merges its config option into the check block, so the
  // runner settings are written here, where readConfig actually looks.
  writeFileSync(enabled.store.paths.config, JSON.stringify({ check: { stale_days: 7, stale_exempt_stages: ['merged'] }, runner: { enabled: true, provider: 'stub', providers: { stub: { cmd: ['stub'] } } } }));
  enabled.store.rebaselineDigest();
  enabled.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  const enabledResult = ctx(enabled);
  assert.equal(run(enabledResult.ctx), 0);
  assert.equal(enabledResult.output(), 'Board is clean.\n', 'a runner that can run will pick the dispatch up');
});

test('a queued dispatch note travels in --json alongside the inbox notes', () => {
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: new Date().toISOString() })]);
  b.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  const result = ctx(b, { json: true });
  assert.equal(run(result.ctx), 0);
  const parsed = JSON.parse(result.output());
  assert.deepEqual(parsed.notes.map((entry) => entry.type), ['inbox', 'queued dispatch']);
  assert.equal(parsed.notes[1].id, 'P1-01');
});

test('an inbox and a queued dispatch get their own headings in one report', () => {
  const b = board([item({ id: 'T-0001', flag: 'needs-triage', updated: new Date().toISOString() })]);
  b.store.appendEvent({ type: 'dispatch', item: 'P1-01', by: 'scheduler' });
  const result = ctx(b);
  assert.equal(run(result.ctx), 0);
  const out = result.output();
  assert.match(out, /^INBOX — 1 item not classified yet\. Not a violation; nothing to do unless you want to\.$/m);
  assert.match(out, /^QUEUED DISPATCH — 1 dispatch no agent will ever run while the runner is disabled\.$/m);
  assert.ok(out.indexOf('INBOX') < out.indexOf('QUEUED DISPATCH'));
});
