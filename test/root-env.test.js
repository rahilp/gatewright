import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { findRoot } from '../lib/cli/root.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

function capture() {
  let err = '';
  return { stderr: { write: (s) => { err += s; } }, get err() { return err; } };
}

// T-0026 — GW_ROOT names the project root, the directory holding
// .gatewright/. The old reading (the .gatewright directory itself) made a
// value aimed at a project root operate on its parent: reads silently showed
// an empty board, writes silently created one. This is the regression test
// for exactly that bite.
test('GW_ROOT names the project root: its board is used and none appears in its parent', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-rootenv-'));
  const project = join(base, 'proj');
  mkdirSync(project);
  const runIn = (cwd, ...args) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GW_ROOT: '' } });
  const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { cwd: base, encoding: 'utf8', env: { ...process.env, GW_ROOT: project } });

  // init works on its cwd; GW_ROOT is how every other command finds the board
  // from somewhere else entirely.
  runIn(project, 'init');
  run('add', 'env board', '--by', 'agent:rootenv');
  assert.match(run('list'), /env board/);
  assert.equal(existsSync(join(base, '.gatewright')), false, 'the old reading put the board in the parent directory');
  assert.equal(existsSync(join(project, '.gatewright')), true);
});

test('GW_ROOT naming .gatewright still works, with a deprecation warning', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-rootlegacy-'));
  const project = join(base, 'proj');
  mkdirSync(join(project, '.gatewright'), { recursive: true });
  const streams = capture();
  assert.equal(findRoot(base, { GW_ROOT: join(project, '.gatewright') }, streams), project);
  assert.match(streams.err, /warning/);
  assert.match(streams.err, /project root/, 'the warning names the new meaning, not just the relocation');
});

test('GW_ROOT pointing where there is no board is refused loudly and creates nothing', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-rootrefuse-'));
  const nowhere = join(base, 'typo');
  const streams = capture();
  // A directory that exists but holds no board…
  assert.throws(() => findRoot(base, { GW_ROOT: nowhere }, streams), (error) => /no \.gatewright\/ found at GW_ROOT/.test(error.message));
  // …a path that does not exist at all (the typo case)…
  assert.throws(() => findRoot(base, { GW_ROOT: join(base, 'projcet') }, streams), (error) => /no \.gatewright\/ found at GW_ROOT/.test(error.message));
  // …and the deprecated form aimed at a board that was never created.
  assert.throws(() => findRoot(base, { GW_ROOT: join(nowhere, '.gatewright') }, streams), (error) => /no \.gatewright\/ found at GW_ROOT/.test(error.message));
  assert.equal(existsSync(nowhere), false, 'the refusal must not create the directory it was handed');
  assert.equal(existsSync(join(base, '.gatewright')), false, 'nor a board anywhere else');
});

test('a command with an unsatisfiable GW_ROOT fails loudly through the binary', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-rootrefuse-'));
  const nowhere = join(base, 'typo');
  let failed;
  try {
    execFileSync(process.execPath, [BIN, 'list'], { cwd: base, encoding: 'utf8', env: { ...process.env, GW_ROOT: nowhere } });
    failed = false;
  } catch (error) {
    failed = true;
    assert.equal(error.status, 3);
    assert.match(error.stderr, /GW_ROOT/);
    assert.match(error.stderr, /gw init/);
  }
  assert.equal(failed, true, 'the command must fail, not silently show an empty board');
});

test('the global help documents what GW_ROOT names', async () => {
  const { runRouter } = await import('../lib/cli/router.js');
  let out = '';
  await runRouter(['--help'], { env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
  assert.match(out, /GW_ROOT names the project root/);
  assert.match(out, /deprecation warning/);
});
