import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/move.js';
import { RuleError, UsageError } from '../lib/cli/errors.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = {
  stages: [
    { id: 'backlog' }, { id: 'building', requires: { owner: true } },
    { id: 'built', requires: { evidence_min: 1 } }, { id: 'verified', requires: { evidence_min: 2 } },
  ], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }, { id: 'paused' }],
};
const item = (over = {}) => ({ id: 'P1-01', title: 'test', stage: 'backlog', flag: null, owner: null, deps: [], evidence: [], updated: '2020-01-01T00:00:00.000Z', gh: null, ...over });

function board(items = [item()], config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-move-'));
  const store = createStore(root); store.ensure(); store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({ github: { enabled: false, comment_on_move: true }, ...config }));
  return { root, store };
}
function ctx(b, positionals, flags = {}) { return { flags, positionals, store: b.store, root: b.root, actor: 'human:test', env: {}, stdout: { write() {} }, stderr: { write() {} } }; }

test('--force never bypasses requires', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['P1-01', 'built'], { force: true })), (error) => error instanceof RuleError && /needs at least 1 evidence/.test(error.failures[0]));
  assert.equal(b.store.readItems()[0].stage, 'backlog');
});

test('move counts command evidence toward the target requirement and writes one move event', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  run(ctx(b, ['P1-01', 'built'], { evidence: ['abc123'] }));
  const moved = b.store.readItems()[0];
  assert.equal(moved.stage, 'built'); assert.deepEqual(moved.evidence, ['abc123']); assert.notEqual(moved.updated, '2020-01-01T00:00:00.000Z');
  assert.deepEqual(b.store.readEvents().map(({ type, item: id, from, to, by, evidence }) => ({ type, item: id, from, to, by, evidence })), [{ type: 'move', item: 'P1-01', from: 'building', to: 'built', by: 'human:test', evidence: ['abc123'] }]);
});

test('move refuses an out-of-order pipeline target without force but allows side stages', () => {
  const b = board();
  assert.throws(() => run(ctx(b, ['P1-01', 'built'])), (error) => error instanceof RuleError && /use --force to skip stages/.test(error.message));
  run(ctx(b, ['P1-01', 'paused']));
  assert.equal(b.store.readItems()[0].stage, 'paused');
});

test('move rejects unknown items, unknown stages, same stages, and terminal moves', () => {
  const b = board();
  for (const args of [['none', 'building'], ['P1-01', 'none'], ['P1-01', 'backlog']]) assert.throws(() => run(ctx(b, args)), UsageError);
  const terminal = board([item({ stage: 'verified', evidence: ['a', 'b'] })]);
  assert.throws(() => run(ctx(terminal, ['P1-01', 'backlog'], { force: true })), UsageError);
});

test('move clears a paused flag and queues a linked GitHub comment without calling gh', () => {
  const b = board([item({ stage: 'paused', flag: 'paused', owner: 'human:test', gh: { number: 7 } })], { github: { enabled: true, comment_on_move: true } });
  run(ctx(b, ['P1-01', 'building'], { force: true }));
  assert.equal(b.store.readItems()[0].flag, null);
  const event = b.store.readEvents()[0]; assert.equal(event.type, 'move'); assert.equal(event.queued_comment, true);
});

test('gw move works through the real binary with the expected exit code', () => {
  const b = board([item({ stage: 'building', owner: 'human:test' })]);
  execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'built', '--evidence', 'abc123'], { cwd: b.root, encoding: 'utf8' });
  assert.equal(b.store.readItems()[0].stage, 'built');
  assert.throws(() => execFileSync(process.execPath, [BIN, 'move', 'P1-01', 'verified'], { cwd: b.root, encoding: 'utf8' }), (error) => error.status === 1);
});
