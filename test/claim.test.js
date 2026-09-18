import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { sameOwner } from '../lib/owner.js';
import { run as claim } from '../lib/commands/claim.js';
import { run as release } from '../lib/commands/release.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo() { const root = mkdtempSync(join(tmpdir(), 'gw-claim-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), '{}'); const store = createStore(root); store.ensure(); store.writeItems([{ id: 'P1-01', owner: null }]); return { root, store }; }
test('claim, conflict, force, no-op reclaim, and release', () => { const { store } = repo(); const ctx = (actor, flags = {}) => ({ store, flags, actor, positionals: ['P1-01'] }); claim(ctx('human:a')); assert.equal(store.readItems()[0].owner, 'human:a'); assert.doesNotThrow(() => claim(ctx('human:a'))); assert.throws(() => claim(ctx('human:b')), /run `gw claim P1-01 --force`/); claim(ctx('human:b', { force: true })); release(ctx('human:b')); assert.equal(store.readItems()[0].owner, null); assert.equal(store.readEvents().filter(e => ['claim', 'release'].includes(e.type)).length, 3); });
test('claim works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'claim', 'P1-01', '--by', 'human:bin'], { cwd: root }); });
test('release works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'release', 'P1-01', '--by', 'human:bin'], { cwd: root }); });

// T-0041 — `--by rahil` stores the bare name; the default actor is
// "human:rahil". They are the same person: reclaim is a no-op, not a
// conflict, and no one is ever forced to claim their own item.
test('a bare --by name and the qualified default actor are the same owner', () => {
  assert.ok(sameOwner('rahil', 'human:rahil'));
  assert.ok(sameOwner('human:rahil', 'rahil'));
  assert.ok(!sameOwner('human:rahil', 'agent:rahil'), 'same name, different kind is not the same owner');
  assert.ok(!sameOwner('rahil', 'other'));
  assert.ok(!sameOwner('rahil', null));

  const { store } = repo();
  const ctx = (actor, flags = {}) => ({ store, flags, actor, positionals: ['P1-01'] });
  claim(ctx('rahil'));
  assert.equal(store.readItems()[0].owner, 'rahil');
  assert.doesNotThrow(() => claim(ctx('human:rahil')), 'reclaiming your own item must be a no-op, not a conflict');
  assert.equal(store.readItems()[0].owner, 'rahil', 'and the stored owner is not silently rewritten');

  claim(ctx('human:b', { force: true }));
  assert.doesNotThrow(() => claim(ctx('b')));
  assert.equal(store.readItems()[0].owner, 'human:b');
  assert.throws(() => claim(ctx('agent:b')), /--force/, 'provenance still separates human:b from agent:b');
});
