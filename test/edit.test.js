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

// T-0040 — `gw check` says "replace or remove dropped dependency", but the
// remove half was impossible: args.js rejected the empty string before edit
// ever saw it, so the clear-the-list branch was dead code and a dependency
// could only ever be replaced. An explicit `--deps ""` (or `--deps=`) must
// clear the list, through the real parser, while a genuinely missing value
// still errors.
test('T-0040: --deps "" and --refs= clear the lists through the real binary', () => {
  const { root, store } = repo();
  store.writeItems([
    store.readItems()[0],
    { ...store.readItems()[0], id: 'P1-02', title: 'other' },
    { ...store.readItems()[0], id: 'P1-03', title: 'third' },
  ]);
  run({ store, actor: 'human:a', flags: { deps: 'P1-02,P1-03', refs: 'R1,R2' }, positionals: ['P1-01'] });
  assert.deepEqual(store.readItems()[0].deps, ['P1-02', 'P1-03']);
  execFileSync(process.execPath, [BIN, 'edit', 'P1-01', '--deps', ''], { cwd: root });
  assert.deepEqual(store.readItems()[0].deps, []);
  execFileSync(process.execPath, [BIN, 'edit', 'P1-01', '--refs='], { cwd: root });
  assert.deepEqual(store.readItems()[0].refs, []);
});

test('T-0040: a genuinely missing --deps value is still a usage error', () => {
  const { root, store } = repo();
  for (const argv of [['edit', 'P1-01', '--deps'], ['edit', 'P1-01', '--deps', '--title', 'x']]) {
    assert.throws(
      () => execFileSync(process.execPath, [BIN, ...argv], { cwd: root, encoding: 'utf8' }),
      (error) => error.status === 2 && /needs a value/.test(`${error.stderr}`),
    );
  }
  assert.deepEqual(store.readItems()[0].deps, [], 'a refused edit writes nothing');
});

// T-0035 — scope is what the evidence gate judged the work against; a silent
// rewrite after verification invalidates the judgement with no trace. The
// rewrite is refused on terminal-stage items, and --force proceeds only by
// recording the change in the item's notes and flagging the event.
test('T-0035: rewriting the scope of a verified item is refused, and --force records it loudly', () => {
  const { store } = repo();
  store.writeItems([{ ...store.readItems()[0], stage: 'verified', scope: 'original scope', evidence: ['commit abc123', 'https://github.com/a/b/pull/4'] }]);
  assert.throws(
    () => run({ store, actor: 'human:a', flags: { scope: 'rewritten after the fact' }, positionals: ['P1-01'] }),
    (error) => /terminal stage 'verified'/.test(error.message) && /--force/.test(error.message),
  );
  assert.equal(store.readItems()[0].scope, 'original scope', 'a refused rewrite leaves the scope untouched');
  assert.equal(store.readEvents().length, 0);

  run({ store, actor: 'agent:opencode', flags: { scope: 'rewritten', force: true }, positionals: ['P1-01'] });
  const item = store.readItems()[0];
  assert.equal(item.scope, 'rewritten');
  assert.match(item.notes, /scope rewritten after verification by agent:opencode: rewritten/);
  const event = store.readEvents().at(-1);
  assert.equal(event.scope_forced, true, 'the event log flags the forced scope change');
  assert.deepEqual(event.fields, ['scope']);
});

test('T-0035: editing other fields of a verified item, or scope of an open item, needs no force', () => {
  const { store } = repo();
  store.writeItems([{ ...store.readItems()[0], stage: 'verified', scope: 'original scope' }]);
  run({ store, actor: 'human:a', flags: { title: 'retitled after verification' }, positionals: ['P1-01'] });
  assert.equal(store.readItems()[0].title, 'retitled after verification');
  assert.equal(store.readEvents().at(-1).scope_forced, undefined);
  store.writeItems([{ ...store.readItems()[0], stage: 'backlog' }]);
  run({ store, actor: 'human:a', flags: { scope: 'clarified while open' }, positionals: ['P1-01'] });
  assert.equal(store.readItems()[0].scope, 'clarified while open');
  assert.equal(store.readEvents().at(-1).scope_forced, undefined);
});

test('T-0035: the binary refuses a verified scope rewrite with exit 1', () => {
  const { root, store } = repo();
  store.writeItems([{ ...store.readItems()[0], stage: 'verified', scope: 'original scope' }]);
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'edit', 'P1-01', '--scope', 'rewritten'], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 1,
  );
  assert.equal(store.readItems()[0].scope, 'original scope');
  execFileSync(process.execPath, [BIN, 'edit', 'P1-01', '--scope', 'rewritten', '--force'], { cwd: root });
  assert.equal(store.readItems()[0].scope, 'rewritten');
});
