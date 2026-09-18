import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/edit.js';
const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo(config = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-edit-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), JSON.stringify({ vocab: {}, ...config })); const store = createStore(root); store.ensure(); store.writeItems([{ id: 'P1-01', title: 'old', scope: '', priority: 'P1', type: 'feature', phase: 'P1', gate: 'G0', deps: [], refs: [], gh: null, updated: 'old' }]); return { root, store }; }
test('edit replaces arrays, validates atomically, and emits changed keys once', () => { const { store } = repo({ vocab: { priority: ['P0', 'P1'] } }); run({ store, actor: 'human:a', flags: { title: 'new', deps: '', refs: 'R1,R2', priority: 'P0' }, positionals: ['P1-01'] }); const item = store.readItems()[0]; assert.equal(item.title, 'new'); assert.deepEqual(item.refs, ['R1', 'R2']); assert.deepEqual(store.readEvents().at(-1).fields, ['title', 'priority', 'deps', 'refs']); const before = readFileSync(store.paths.items); assert.throws(() => run({ store, actor: 'human:a', flags: { title: 'changed', priority: 'BAD' }, positionals: ['P1-01'] }), /P0.*P1/); assert.deepEqual(readFileSync(store.paths.items), before); });
test('edit refuses GitHub-owned fields with URL and works through the real binary', () => { const { root, store } = repo(); store.writeItems([{ ...store.readItems()[0], gh: { number: 4, url: 'https://github.com/a/b/issues/4' } }]); assert.throws(() => run({ store, actor: 'human:a', flags: { title: 'nope', scope: 'nope' }, positionals: ['P1-01'] }), /title.*scope|scope.*title/); execFileSync(process.execPath, [BIN, 'edit', 'P1-01', '--refs', 'R2'], { cwd: root }); });
test('edit uses the shared vocabulary validation message', () => { const { store } = repo({ vocab: { type: ['feature'] } }); assert.throws(() => run({ store, actor: 'human:a', flags: { type: 'defect' }, positionals: ['P1-01'] }), /invalid --type 'defect'; allowed values: feature/); });

// T-0009 — the same door `add` enforces, on the edit path: a newline or
// blank --title is refused before anything is written.
test('edit refuses a newline, empty, or whitespace-only --title without writing', () => {
  const { store } = repo();
  for (const value of ['a\nb', '', '   ']) {
    assert.throws(
      () => run({ store, actor: 'human:a', flags: { title: value }, positionals: ['P1-01'] }),
      (error) => error.message === 'title must not contain newlines' || error.message === 'title must not be empty',
      `--title ${JSON.stringify(value)} must be refused`,
    );
  }
  assert.equal(store.readItems()[0].title, 'old');
  assert.equal(store.readEvents().length, 0);
});
