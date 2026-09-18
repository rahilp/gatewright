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

test('parseMarkdown round-trips the real tasks.md with 89 items and correct details', () => {
  const text = readFileSync(TASKS_MD, 'utf8');
  const { items, skipped } = parseMarkdown(text);
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 89); // hand-counted; bump deliberately when tasks.md gains items

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
  // A scope, because `specified` now requires one and these gates are
  // cumulative. The subject of this test is evidence, not scoping.
  const base = { id: 'X', owner: 'human:tester', deps: [], evidence: [], scope: 'what done looks like' };
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

// T-0008 — a JSON array whose rows all lack an id used to exit 0 with
// "imported 0, skipped 1" while the identical CSV failure exited 2. A CI
// script checking the exit code read success from an import that imported
// nothing. The rule now, for every format: rows present and none importable
// is a usage error naming what was wrong; a file with no rows at all is not
// an error.
test('json and csv agree: every row skipped is an exit-2 failure naming the reason', async () => {
  const cases = [
    // JSON numbers records; csv numbers physical file lines, so the header row
    // shifts them by one. The verdict, the reason and the message shape agree.
    { file: 'rows.json', text: '[{"title":"No id"},{"title":"Still no id"}]', lines: 'lines 1, 2' },
    { file: 'rows.csv', text: 'id,title\n,No id\n,Still no id\n', lines: 'lines 2, 3' },
  ];
  for (const { file, text, lines } of cases) {
    const { root, store } = repo();
    const path = join(root, file);
    writeFileSync(path, text);
    const streams = capture();
    await assert.rejects(
      () => run({ store, root, actor: 'human:tester', flags: {}, positionals: [path], ...streams }),
      (error) => error instanceof UsageError
        && error.message === `nothing imported from ${path}: all 2 row(s) were skipped (missing id or title: ${lines})`,
      `${file} must fail with the same message shape as every other format`,
    );
    assert.equal(streams.lines.join(''), '');
    assert.equal(store.readItems().length, 0);
  }
});

test('a json or csv file with no rows at all is not an error', async () => {
  const cases = [
    { file: 'empty.json', text: '[]', out: 'no importable rows found in' },
    { file: 'empty.csv', text: 'id,title\n', out: 'no importable rows found in' },
  ];
  for (const { file, text, out } of cases) {
    const { root, store } = repo();
    const path = join(root, file);
    writeFileSync(path, text);
    const streams = capture();
    const code = await run({ store, root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
    assert.equal(code, 0, `${file} with zero rows is not a failure`);
    assert.match(streams.lines.join(''), new RegExp(`^${out}`));
    assert.equal(store.readItems().length, 0);
  }
});

test('a partially skipped import still succeeds and still names the skipped rows', async () => {
  const { root, store } = repo();
  const path = join(root, 'mixed.json');
  writeFileSync(path, '[{"id":"J-1","title":"Good"},{"title":"No id"}]');
  const streams = capture();
  const code = await run({ store, root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  assert.equal(store.readItems().length, 1);
  assert.match(streams.lines.join(''), /^imported 1, skipped 1\n  skipped line 2: missing id or title\n$/);
});

test('the all-rows-skipped failure also applies to --dry-run', async () => {
  const { root, store } = repo();
  const path = join(root, 'rows.json');
  writeFileSync(path, '[{"title":"No id"}]');
  await assert.rejects(
    () => run({ store, root, actor: 'human:tester', flags: { 'dry-run': true }, positionals: [path], stdout: capture().stdout }),
    (error) => error instanceof UsageError && /all 1 row\(s\) were skipped/.test(error.message),
  );
  assert.equal(store.readItems().length, 0);
});

// T-0007 — `gw add --phase ZZZ` is refused at exit 2, so the same value
// through an import must not land on the board silently and surface only
// later in `gw check`. A bad row is skipped with its line and reason, like
// any other malformed row; a file whose every row is bad fails like any
// other all-skipped file.
test('import applies the same vocabulary as add: bad values are skipped with line and reason', async () => {
  const { root, store } = repo();
  const path = join(root, 'vocab.csv');
  writeFileSync(path, 'id,title,phase,type\nP1-01,Good,P1,feature\nP1-02,Bad phase,P9,feature\nP1-03,Bad type,P1,chore\n');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  const stored = store.readItems();
  assert.deepEqual(stored.map((item) => item.id), ['P1-01']);
  assert.equal(streams.lines.join(''), 'imported 1, skipped 2\n'
    + '  skipped line 3: invalid phase \'P9\' (allowed values: P0, P1, P2, P3)\n'
    + '  skipped line 4: invalid type \'chore\' (allowed values: decision, defect, feature, test, doc)\n');
});

test('an import whose every row is out of vocabulary imports nothing and fails like any all-skipped file', async () => {
  const { root, store } = repo();
  const path = join(root, 'all-bad.json');
  writeFileSync(path, '[{"id":"J-1","title":"T","priority":"P9"}]');
  const streams = capture();
  await assert.rejects(
    () => run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [path], ...streams }),
    (error) => error instanceof UsageError
      && error.message === `nothing imported from ${path}: all 1 row(s) were skipped (invalid priority 'P9' (allowed values: P0, P1, P2, P3): line 1)`,
  );
  assert.equal(streams.lines.join(''), '');
  assert.equal(store.readItems().length, 0);
});

test('an out-of-vocabulary row is skipped on --dry-run too, with the same reason', async () => {
  const { root, store } = repo();
  const path = join(root, 'dry-bad.csv');
  writeFileSync(path, 'id,title,priority\nP1-01,Good,P1\nP1-02,Bad,P9\n');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: { 'dry-run': true }, positionals: [path], ...streams });
  assert.equal(code, 0);
  assert.equal(store.readItems().length, 0);
  assert.equal(streams.lines.join(''), 'would import P1-01: Good\n'
    + 'would import 1 item(s), skipped 1\n'
    + '  skipped line 3: invalid priority \'P9\' (allowed values: P0, P1, P2, P3)\n');
});

// T-0009 (import side) — a title holding a newline is skipped with a reason,
// the same way a row missing its title is.
test('a title containing a newline is skipped with a reason, not imported', async () => {
  const { root, store } = repo();
  const path = join(root, 'newline.csv');
  writeFileSync(path, 'id,title\nP1-01,Good\nP1-02,"multi\nline"\n');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  assert.deepEqual(store.readItems().map((item) => item.id), ['P1-01']);
  assert.match(streams.lines.join(''), /^imported 1, skipped 1\n  skipped line 3: title must not contain newlines\n$/);
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
