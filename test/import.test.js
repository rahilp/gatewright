import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, inferStage } from '../lib/import/md.js';
import { run, resolveImportStage, resolveImportStages } from '../lib/commands/import.js';
import { createStore } from '../lib/store.js';
import { RuleError, UsageError } from '../lib/cli/errors.js';
import { evaluateCumulative, findCycles, missingDeps } from '../lib/rules.js';
import { readStages } from '../lib/config.js';

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

function defaultStages() {
  return readStages({ paths: { stages: join(tmpdir(), `gw-stages-${Date.now()}.json`) } });
}

test('inferStage returns neutral initial and done markers', () => {
  assert.equal(inferStage('plain scope'), 'initial');
  assert.equal(inferStage('**Decided:** we will do it'), 'done');
  assert.equal(inferStage('Scope ends with ✅'), 'done');
  assert.equal(inferStage('  **Decided:** padded  '), 'done');
  assert.equal(inferStage('Trailing whitespace ✅  '), 'done');
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
  assert.equal(scopeWithDot, 'The `foo · bar` case.');

  assert.equal(items.find((i) => i.id === 'P1-01').title, 'No deps em dash');
  assert.equal(items.find((i) => i.id === 'P1-06').stage, 'done');
  assert.equal(items.find((i) => i.id === 'P1-07').stage, 'done');
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
  assert.equal(p101.stage, 'initial');

  const p108a = items.find((i) => i.id === 'P1-08a');
  assert.equal(p108a.scope[0], 'P');
  assert.match(p108a.scope, /^Per `specs.md`/);

  assert.equal(items.find((i) => i.id === 'P0-01').stage, 'done');
});

test('resolveImportStage places verified only when requirements are actually met', () => {
  const stages = defaultStages();
  const base = { id: 'X', owner: 'human:tester', deps: [], evidence: [] };
  const noEvidence = resolveImportStage({ ...base }, 'verified', { items: [], stages });
  assert.equal(noEvidence.stage, 'backlog');
  assert.match(noEvidence.reason, /2 evidence/);

  const withEvidence = resolveImportStage({ ...base, evidence: ['abc123', 'https://github.com/a/b/pull/1'] }, 'verified', { items: [], stages });
  assert.equal(withEvidence.stage, 'verified');
  assert.equal(withEvidence.reason, null);
});

test('import command downgrades unearned verified items and reports them', async () => {
  const { store } = repo();
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [FIXTURE], ...streams });
  assert.equal(code, 0);
  const stored = store.readItems();
  assert.equal(stored.length, 8);
  assert.equal(stored.find((i) => i.id === 'P1-06').stage, 'backlog');
  assert.equal(stored.find((i) => i.id === 'P1-07').stage, 'backlog');

  const out = streams.lines.join('');
  assert.match(out, /P1-06: source says done, imported to backlog \(verified needs at least 2 evidence entries\)/);
  assert.match(out, /P1-07: source says done, imported to backlog \(verified needs at least 2 evidence entries\)/);
  assert.match(out, /2 item\(s\) marked done in the source could not enter verified/);

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

test('import rejects files without strict phase headings', async () => {
  const { root, store } = repo();
  const file = join(root, 'foreign-phases.md');
  writeFileSync(file, '## X1 — Work\n- **X1-01** · Item · feature · G0 · — · Scope\n');
  const streams = capture();
  await assert.rejects(
    () => run({ store, root, actor: 'human:tester', flags: {}, positionals: [file], ...streams }),
    (error) => error instanceof UsageError && error.message === 'no `## P<n> —` phase headings found; see specs §6 for the expected format',
  );
  assert.equal(streams.lines.join(''), '');
  assert.equal(store.readItems().length, 0);
});

test('import accepts a valid empty phase section', async () => {
  const { root, store } = repo();
  const file = join(root, 'empty-phase.md');
  writeFileSync(file, '## P1 — Work\n');
  const streams = capture();
  assert.equal(await run({ store, root, actor: 'human:tester', flags: {}, positionals: [file], ...streams }), 0);
  assert.equal(streams.lines.join(''), 'no importable task lines found under phase headings; see specs §6 for the expected format\n');
  assert.equal(store.readItems().length, 0);
});

test('import through the real binary in a temp repo', () => {
  const { root } = repo();
  const out = execFileSync(process.execPath, [BIN, 'import', FIXTURE], { cwd: root, encoding: 'utf8' });
  assert.match(out, /imported 8/);
  const items = createStore(root).readItems();
  assert.equal(items.length, 8);
  assert.ok(items.some((i) => i.id === 'P1-05' && i.scope.includes('foo · bar')));
});

test('importing the real tasks.md never produces a board that fails stage rules', async () => {
  const { store } = repo();
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [TASKS_MD], ...streams });
  assert.equal(code, 0);
  const items = store.readItems();
  const stages = readStages(store);

  for (const item of items) {
    const { ok, failures } = evaluateCumulative(item, item.stage, { items, stages });
    assert.ok(ok, `${item.id} in ${item.stage} violates its stage rules: ${failures.join('; ')}`);
  }

  assert.deepEqual(findCycles(items), []);
  assert.deepEqual(missingDeps(items), []);
});
