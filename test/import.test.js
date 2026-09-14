import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, inferStage } from '../lib/import/md.js';
import { run } from '../lib/commands/import.js';
import { createStore } from '../lib/store.js';
import { RuleError } from '../lib/cli/errors.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/sample-tasks.md', import.meta.url));
const TASKS_MD = fileURLToPath(new URL('../tasks.md', import.meta.url));

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gw-import-'));
  mkdirSync(join(root, '.gatewright'));
  const store = createStore(root);
  store.ensure();
  return { root, store };
}

function capture() {
  const out = [];
  return { stdout: { write: (s) => { out.push(s); } }, lines: out };
}

test('inferStage defaults to backlog, marks decided and checked scopes verified', () => {
  assert.equal(inferStage('plain scope'), 'backlog');
  assert.equal(inferStage('**Decided:** we will do it'), 'verified');
  assert.equal(inferStage('Scope ends with ✅'), 'verified');
  assert.equal(inferStage('  **Decided:** padded  '), 'verified');
  assert.equal(inferStage('Trailing whitespace ✅  '), 'verified');
});

test('parseMarkdown returns items, deps, and skipped malformed lines', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const { items, skipped } = parseMarkdown(text);
  const ids = items.map((i) => i.id);
  assert.deepEqual(ids, ['P1-01', 'P1-02', 'P1-03', 'P1-04', 'P1-04.1', 'P1-05', 'P1-06', 'P1-07']);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 11);
  assert.match(skipped[0].text, /P1-08/);

  assert.deepEqual(items.find((i) => i.id === 'P1-01').deps, []);
  assert.deepEqual(items.find((i) => i.id === 'P1-02').deps, []);
  assert.deepEqual(items.find((i) => i.id === 'P1-03').deps, ['P1-01']);
  assert.deepEqual(items.find((i) => i.id === 'P1-04').deps, ['P1-01', 'P1-02', 'P1-04.1']);
  assert.deepEqual(items.find((i) => i.id === 'P1-04.1').deps, []);

  const scopeWithDot = items.find((i) => i.id === 'P1-05').scope;
  assert.equal(scopeWithDot, ' The `foo · bar` case.');

  assert.equal(items.find((i) => i.id === 'P1-06').stage, 'verified');
  assert.equal(items.find((i) => i.id === 'P1-07').stage, 'verified');
});

test('parseMarkdown round-trips the real tasks.md with 81 items and correct details', () => {
  const text = readFileSync(TASKS_MD, 'utf8');
  const { items, skipped } = parseMarkdown(text);
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 81);

  const ids = new Set(items.map((i) => i.id));
  for (const id of ['P0-01', 'P1-01', 'P1-08a', 'P1-20', 'P4-01', 'P5-14']) {
    assert.ok(ids.has(id), `missing expected id ${id}`);
  }
  for (const bad of ['Rebuild `items.jsonl` from events.', 'events.jsonl rotation', 'Multi-repo aggregation']) {
    assert.ok(!ids.has(bad), `parking-lot line leaked as item ${bad}`);
  }

  assert.deepEqual(items.find((i) => i.id === 'P1-20').deps, ['P1-16', 'P1-17', 'P1-18', 'P1-13a', 'P1-10a']);
  assert.deepEqual(items.find((i) => i.id === 'P1-01').deps, ['P0-02', 'P0-03']);

  const p101 = items.find((i) => i.id === 'P1-01');
  assert.match(p101.scope, /`package.json`/);
  assert.match(p101.scope, /`node --test`/);
  assert.equal(p101.stage, 'backlog');

  assert.equal(items.find((i) => i.id === 'P0-01').stage, 'verified');
});

test('import command writes items and add events, then refuses collisions', async () => {
  const { store } = repo();
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [FIXTURE], ...streams });
  assert.equal(code, 0);
  const stored = store.readItems();
  assert.equal(stored.length, 8);
  assert.deepEqual(stored.map((i) => i.id), ['P1-01', 'P1-02', 'P1-03', 'P1-04', 'P1-04.1', 'P1-05', 'P1-06', 'P1-07']);
  assert.ok(stored.every((i) => i.created_by === 'human:tester'));

  const events = store.readEvents();
  assert.equal(events.length, 8);
  assert.ok(events.every((e) => e.type === 'add' && e.by === 'human:tester'));

  const second = capture();
  await assert.rejects(
    () => run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [FIXTURE], ...second }),
    (err) => err instanceof RuleError && /overwrite/.test(err.message) && err.failures.includes('P1-01'),
  );
});

test('import --dry-run prints a summary and writes nothing', async () => {
  const { store } = repo();
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: { 'dry-run': true }, positionals: [FIXTURE], ...streams });
  assert.equal(code, 0);
  assert.equal(store.readItems().length, 0);
  assert.equal(store.readEvents().length, 0);
  const out = streams.lines.join('');
  assert.match(out, /would import 8 item\(s\)/);
  assert.match(out, /P1-04\.1/);
});

test('import through the real binary in a temp repo', () => {
  const { root } = repo();
  const out = execFileSync(process.execPath, [BIN, 'import', FIXTURE], { cwd: root, encoding: 'utf8' });
  assert.match(out, /imported 8/);
  const items = createStore(root).readItems();
  assert.equal(items.length, 8);
  assert.ok(items.some((i) => i.id === 'P1-05' && i.scope.includes('foo · bar')));
});
