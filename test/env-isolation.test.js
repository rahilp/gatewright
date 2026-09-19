import { ISOLATED_VARS } from './helpers/isolate-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// T-0123 — the tests spawn gw with a scratch cwd but used to inherit the
// caller's environment, and gw prefers GW_ROOT over the cwd. A shell with
// GW_ROOT exported therefore wrote every fixture item into whatever board it
// named: on the owner's machine, their real one. These tests aim the whole
// caller state at a sentinel board and require it to come out byte-identical,
// through the runner and through a bare `node --test` alike.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(REPO, 'bin/gw.js');
const RUNNER = join(REPO, 'scripts/test.mjs');

const roots = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function snapshot(dir) {
  const files = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    files[relative(dir, path)] = readFileSync(path).toString('base64');
  }
  return files;
}

function sentinelBoard() {
  const root = mkdtempSync(join(tmpdir(), 'gw-sentinel-'));
  roots.push(root);
  execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  return root;
}

// Every variable the scrub removes, set the way a real caller would have it:
// an agent's shell pointed at its own board.
function callerEnv(sentinel) {
  const env = {
    ...process.env,
    GW_ROOT: sentinel,
    GW_ACTOR: 'agent:sentinel',
    GW_ITEM: 'P1-01',
    GW_NO_INPUT: '1',
    GW_TUI: 'plain',
    GW_DEBUG: '1',
    CLAUDECODE: '1',
    AI_AGENT: 'sentinel',
    CURSOR_AGENT: '1',
  };
  // Launched from a node:test worker, the child must be an ordinary Node
  // process rather than another worker reporting into this one.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('the scrub list covers every GW_* variable gw itself reads', () => {
  const read = new Set();
  for (const dir of ['lib', 'bin']) {
    for (const entry of readdirSync(join(REPO, dir), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      const source = readFileSync(join(entry.parentPath ?? entry.path, entry.name), 'utf8');
      for (const [name] of source.matchAll(/GW_[A-Z_]+/g)) read.add(name);
    }
  }
  const missing = [...read].filter((name) => !ISOLATED_VARS.includes(name));
  assert.deepEqual(missing, [], 'a GW_* variable gw reads must be scrubbed from the test environment (test/helpers/isolate-env.js)');
});

test('every test file imports the environment guard before anything else', () => {
  const dir = join(REPO, 'test');
  const unguarded = readdirSync(dir).filter((name) => name.endsWith('.test.js')).filter((name) => {
    const first = readFileSync(join(dir, name), 'utf8').match(/^import\b[^;]*;/m)?.[0] ?? '';
    return !/['"]\.\/helpers\/isolate-env\.js['"]/.test(first);
  });
  assert.deepEqual(unguarded, [], 'a bare `node --test` of these files would inherit GW_ROOT and write into the caller\'s board');
});

test('the runner keeps a caller\'s GW_ROOT, actor and agent variables away from the suite', () => {
  const sentinel = sentinelBoard();
  const before = snapshot(sentinel);
  // The real files scrub themselves on import, so on their own they would
  // pass even if the runner passed everything through. This one does not
  // import the guard: it sees exactly what the runner hands the suite.
  const probeDir = mkdtempSync(join(tmpdir(), 'gw-env-probe-'));
  roots.push(probeDir);
  const probe = join(probeDir, 'probe.test.js');
  writeFileSync(probe, [
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    `const names = ${JSON.stringify(ISOLATED_VARS)};`,
    "test('the runner hands the suite no caller gw state', () => {",
    "  assert.deepEqual(names.filter((name) => process.env[name] !== undefined), []);",
    "});",
  ].join('\n'));
  const files = [probe, ...['add', 'move', 'triage', 'root-env'].map((name) => join('test', `${name}.test.js`))];
  const result = spawnSync(process.execPath, [RUNNER], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...callerEnv(sentinel), GW_TEST_FILES: JSON.stringify(files) },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(sentinel), before, 'the board GW_ROOT named is byte-identical after the run');
});

test('a bare `node --test` keeps a caller\'s GW_ROOT away from the suite too', () => {
  const sentinel = sentinelBoard();
  const before = snapshot(sentinel);
  const result = spawnSync(process.execPath, ['--test', join('test', 'add.test.js')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 120_000,
    env: callerEnv(sentinel),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(snapshot(sentinel), before, 'the board GW_ROOT named is byte-identical after the run');
});
