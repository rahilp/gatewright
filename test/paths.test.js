import test from 'node:test';
import assert from 'node:assert/strict';
import { win32, posix } from 'node:path';
import { mkdtempSync } from 'node:fs';
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

test('isWithin answers containment for both shapes', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-paths-'));
  assert.equal(isWithin(join(root, 'lib', 'a.js'), root), true);
  assert.equal(isWithin(root, root), true, 'the root is within itself');
  assert.equal(isWithin('/etc/hosts', root), false);
  assert.equal(isWithin(`${root}-sibling`, root), false, 'a shared prefix is not containment');
});
