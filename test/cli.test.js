import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));

const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('--version prints the package version', () => {
  assert.equal(run('--version').trim(), PKG.version);
});

test('--help lists the commands an agent needs', () => {
  const out = run('--help');
  for (const cmd of ['brief', 'add', 'edit', 'claim', 'move', 'note', 'show', 'check']) {
    assert.match(out, new RegExp(`\\b${cmd}\\b`), `--help should mention ${cmd}`);
  }
});

test('an unknown command exits 2 (usage error)', () => {
  try {
    run('nonsense');
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /nonsense/);
  }
});
