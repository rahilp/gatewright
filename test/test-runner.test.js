import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath(new URL('../scripts/test.mjs', import.meta.url));

// Run directly with `node --test`, nothing sweeps these, so remove them here.
const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function isolatedTemp() {
  const root = mkdtempSync(join(tmpdir(), 'gw-test-runner-'));
  roots.push(root);
  return root;
}

function fixture(root, name, source) {
  const path = join(root, name);
  writeFileSync(path, source);
  return path;
}

function runRunner(root, files, extra = {}) {
  const env = {
    ...process.env,
    TMPDIR: root,
    TEMP: root,
    TMP: root,
    GW_TEST_FILES: JSON.stringify(files),
    ...extra,
  };
  // A runner launched from a node:test worker must be an ordinary Node
  // process, not another worker inheriting NODE_TEST_CONTEXT.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUNNER], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 15_000,
    env,
  });
}

test('the test runner reclaims stale scratch boards at startup and preserves fresh ones', () => {
  const root = isolatedTemp();
  const old = mkdtempSync(join(root, 'gw-old-leak-'));
  const oldGatewright = mkdtempSync(join(root, 'gatewright-old-leak-'));
  const fresh = mkdtempSync(join(root, 'gw-fresh-board-'));
  const oldTime = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(old, oldTime, oldTime);
  utimesSync(oldGatewright, oldTime, oldTime);
  const pass = fixture(root, 'pass.test.js', "import { after, test } from 'node:test'; test('passes', () => {});\n");

  const result = runRunner(root, [pass]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(oldGatewright), false);
  assert.equal(existsSync(fresh), true, 'a live concurrent board is newer than the stale threshold');
});

test('an injected interrupt forwards to the child and still sweeps its scratch board', () => {
  const root = isolatedTemp();
  const hanging = fixture(root, 'hanging.test.js', [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { after, test } from 'node:test';",
    "test('waits for an interrupt', async () => {",
    "  mkdtempSync(join(tmpdir(), 'gw-interrupted-board-'));",
    "  await new Promise(() => {});",
    "});",
  ].join('\n'));

  const result = runRunner(root, [hanging], {
    GW_TEST_INTERRUPT: 'SIGTERM',
    GW_TEST_INTERRUPT_AFTER_MS: '500',
  });
  assert.equal(result.status, 143, result.stderr);
  assert.equal(readdirSync(root).some((name) => name.startsWith('gw-test-run-')), false, 'the per-run temp root is removed after an interrupt');
});

// T-0101 — two `npm test` runs at once must not delete each other's boards.
// The fixture stands in for the other run: it creates a fresh board in the
// shared tmpdir while this run is live, and that board must survive.
test('a run sweeps only its own temp root, never a concurrent run\'s fresh board', () => {
  const root = isolatedTemp();
  const probe = fixture(root, 'probe.test.js', [
    "import assert from 'node:assert/strict';",
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { basename, dirname, join } from 'node:path';",
    "import { after, test } from 'node:test';",
    "test('runs in a private temp root', () => {",
    "  assert.match(basename(tmpdir()), /^gw-test-run-/);",
    "  assert.equal(dirname(tmpdir()), process.env.GW_SHARED_TMP);",
    "  for (const key of ['TMPDIR', 'TEMP', 'TMP']) assert.equal(process.env[key], tmpdir());",
    "  mkdtempSync(join(tmpdir(), 'gw-own-board-'));",
    "  mkdtempSync(join(process.env.GW_SHARED_TMP, 'gw-concurrent-board-'));",
    "});",
  ].join('\n'));

  const result = runRunner(root, [probe], { GW_SHARED_TMP: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const left = readdirSync(root);
  assert.equal(left.some((name) => name.startsWith('gw-concurrent-board-')), true, 'a concurrent run\'s fresh board survives');
  assert.equal(left.some((name) => name.startsWith('gw-test-run-')), false, 'this run\'s own temp root, boards and all, is gone');
});
