import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/note.js';
const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo() { const root = mkdtempSync(join(tmpdir(), 'gw-note-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), '{}'); const store = createStore(root); store.ensure(); store.writeItems([{ id: 'P1-01', notes: 'old' }]); return { root, store }; }
test('note preserves existing notes and records one note event', () => { const { store } = repo(); run({ store, actor: 'human:a', flags: {}, positionals: ['P1-01', 'new note'] }); assert.match(store.readItems()[0].notes, /^old\n\[[^\]]+\] new note$/); assert.equal(store.readEvents().at(-1).note, 'new note'); });
test('note works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'note', 'P1-01', 'binary note'], { cwd: root }); });
// T-0013 — an empty note is a paste error, not a thought: refused before
// anything is written, in either form it arrives (`""` or whitespace).
test('an empty or whitespace-only note is refused and records nothing', () => {
  const { store } = repo();
  for (const text of ['', '   ']) {
    assert.throws(
      () => run({ store, actor: 'human:a', flags: {}, positionals: ['P1-01', text] }),
      (error) => error.message === 'note text must not be empty',
    );
  }
  assert.equal(store.readEvents().length, 0);
  assert.equal(store.readItems()[0].notes, 'old');
});
test('an empty note exits 2 through the real binary', () => {
  const { root } = repo();
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'note', 'P1-01', ''], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 2,
  );
});
