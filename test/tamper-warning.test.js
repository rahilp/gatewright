import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

test('human-readable read commands reveal an out-of-band board write', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-tamper-warning-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems([{ id: 'P1-01', title: 'Forged completion', stage: 'verified', flag: null, owner: null, deps: [], evidence: [] }]);
  // This is deliberately not a store write: a harmless-looking hand edit
  // makes the digest mismatch while leaving every reader able to parse it.
  appendFileSync(store.paths.items, '\n');

  for (const args of [['brief'], ['list'], ['next', 'P1-01'], ['show', 'P1-01']]) {
    const output = execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
    assert.match(output, /modified outside gw/, `gw ${args.join(' ')} exposes the untrusted board state`);
    assert.match(output, /gw check/, `gw ${args.join(' ')} points to the command that explains it`);
  }
});
