import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'))).version;

function npm(args, options = {}) {
  return spawnSync('npm', args, { encoding: 'utf8', timeout: 60_000, ...options });
}

function run(bin, args, cwd) {
  return spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

test('packed installation exposes working gw and gatewright shims', (t) => {
  const probe = npm(['--version']);
  if (probe.error?.code === 'ENOENT') {
    t.skip('npm is unavailable; skipping packed-installation coverage');
    return;
  }
  assert.equal(probe.status, 0, probe.stderr);

  const packed = mkdtempSync(join(tmpdir(), 'gw-pack-'));
  const pack = npm(['pack', '--json', '--pack-destination', packed], { cwd: ROOT });
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout);
  const tarball = join(packed, filename);
  assert.equal(existsSync(tarball), true);

  const project = mkdtempSync(join(tmpdir(), 'gw-install-'));
  const install = npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball], { cwd: project });
  assert.equal(install.status, 0, install.stderr);

  for (const name of ['gw', 'gatewright']) {
    const bin = join(project, 'node_modules', '.bin', name);
    const version = run(bin, ['--version'], project);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `${VERSION}\n`);

    const help = run(bin, ['--help'], project);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /usage: gw <command>/);

    const repo = mkdtempSync(join(project, `${name}-repo-`));
    const init = run(bin, ['init'], repo);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(existsSync(join(repo, '.gatewright')), true);
  }
});
