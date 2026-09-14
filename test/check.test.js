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
const stages = { stages: [{ id: 'backlog' }, { id: 'building', requires: { owner: true } }, { id: 'built', requires: { evidence_min: 1 } }, { id: 'verified' }], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', owner: null, deps: [], evidence: [], updated: new Date().toISOString(), gh: null, flag: null, ...over });
function board(items = [item()]) { const root = mkdtempSync(join(tmpdir(), 'gw-check-')); const store = createStore(root); store.ensure(); store.writeItems(items); writeFileSync(store.paths.stages, JSON.stringify(stages)); writeFileSync(store.paths.config, JSON.stringify({ check: { stale_days: 7 } })); return { root, store }; }
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
});

test('check --json is machine-readable and the real binary exits 1 for violations', () => {
  const b = board([item({ stage: 'building' })]); const result = ctx(b, { json: true });
  assert.equal(run(result.ctx), 1); assert.ok(Array.isArray(JSON.parse(result.output()).problems));
  assert.throws(() => execFileSync(process.execPath, [BIN, 'check'], { cwd: b.root, encoding: 'utf8' }), (error) => error.status === 1);
});
