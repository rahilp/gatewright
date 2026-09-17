import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, posix } from 'node:path';
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWithin } from '../lib/util/paths.js';

// The assumption the helper is built on, pinned so it is visible rather than
// remembered: between two drives, Windows cannot express the answer as `..`
// and returns the target absolute instead. Any containment check written as
// "does relative() start with .." therefore reads a path on another drive as
// inside the parent — which is how `gw guard --pretool` came to gate
// /etc/hosts on Windows while behaving correctly everywhere else.
test('relative() cannot express containment with .. across Windows drives', () => {
  assert.equal(win32.relative('C:\\repo', 'D:\\etc\\hosts'), 'D:\\etc\\hosts');
  assert.equal(posix.relative('/repo', '/etc/hosts'), '../etc/hosts');
});

// The case the enforcement actually depends on: an agent's `Write` names a
// file that does not exist yet, so it cannot be realpath'd -- while its root
// can. Normalising only the side that exists compares a resolved parent
// against an unresolved child, and on any machine whose repository sits under
// a symlink (macOS /tmp -> /private/tmp, a Windows 8.3 short name) a brand-new
// file inside the repository reads as outside it, and goes ungated.
test('isWithin places a file that does not exist yet under a symlinked root', () => {
  const base = mkdtempSync(join(tmpdir(), 'gw-symlink-'));
  const real = join(base, 'real');
  const link = join(base, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  assert.equal(isWithin(join(link, 'brand-new.js'), link), true);
  assert.equal(isWithin(join(link, 'lib', 'deep', 'brand-new.js'), link), true);
  assert.equal(isWithin(join(base, 'elsewhere.js'), link), false, 'a sibling that does not exist is still outside');
});

test('isWithin answers containment for both shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-paths-'));
  assert.equal(isWithin(join(root, 'lib', 'a.js'), root), true);
  assert.equal(isWithin(root, root), true, 'the root is within itself');
  assert.equal(isWithin('/etc/hosts', root), false);
  assert.equal(isWithin(`${root}-sibling`, root), false, 'a shared prefix is not containment');
});
