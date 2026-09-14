import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/check.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = { stages: [{ id: 'backlog' }, { id: 'specified' }, { id: 'building', requires: { owner: true } }, { id: 'built', requires: { evidence_min: 1 } }, { id: 'in_review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } }, { id: 'reviewed' }, { id: 'merged' }, { id: 'verified', requires: { evidence_min: 2 } }], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', owner: null, deps: [], evidence: [], updated: new Date().toISOString(), gh: null, flag: null, ...over });
function board(items = [item()], { stages: boardStages = stages, config = {} } = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-check-')); const store = createStore(root); store.ensure(); store.writeItems(items); writeFileSync(store.paths.stages, JSON.stringify(boardStages)); writeFileSync(store.paths.config, JSON.stringify({ check: { stale_days: 7, stale_exempt_stages: ['merged'], ...config } })); return { root, store }; }
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
  assert.match(result.output(), /CURRENT STAGE RULE[\s\S]*P1-01[\s\S]*needs at least 2 evidence/i);
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
  assert.match(result.output(), /CURRENT STAGE RULE[\s\S]*P1-01[\s\S]*built: needs at least 1 evidence/i);
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
