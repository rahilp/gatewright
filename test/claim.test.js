import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run as claim } from '../lib/commands/claim.js';
import { run as release } from '../lib/commands/release.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo() { const root = mkdtempSync(join(tmpdir(), 'gw-claim-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), '{}'); const store = createStore(root); store.ensure(); store.writeItems([{ id: 'P1-01', owner: null }]); return { root, store }; }
test('claim, conflict, force, no-op reclaim, and release', () => { const { store } = repo(); const ctx = (actor, flags = {}) => ({ store, flags, actor, positionals: ['P1-01'] }); claim(ctx('human:a')); assert.equal(store.readItems()[0].owner, 'human:a'); assert.doesNotThrow(() => claim(ctx('human:a'))); assert.throws(() => claim(ctx('human:b')), /owned/i); claim(ctx('human:b', { force: true })); release(ctx('human:b')); assert.equal(store.readItems()[0].owner, null); assert.equal(store.readEvents().filter(e => ['claim', 'release'].includes(e.type)).length, 3); });
test('claim works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'claim', 'P1-01', '--by', 'human:bin'], { cwd: root }); });
test('release works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'release', 'P1-01', '--by', 'human:bin'], { cwd: root }); });
