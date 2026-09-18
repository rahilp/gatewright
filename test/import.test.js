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
  assert.match(noEvidence.reason, /two new pieces of evidence/);

  // The real import path evaluates an intended stage with the item already
  // standing in it (lib/commands/import.js sets `stage` before asking), so
  // legacy flat-string evidence earns the stage it was recorded against.
  const withEvidence = resolveImportStage({ ...base, stage: 'verified', evidence: ['abc123', 'https://github.com/a/b/pull/1'] }, 'verified', { items: [], stages });
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
  assert.match(out, /P1-06: source says done, imported to backlog \(verified Needs at least two new pieces of evidence, distinct from anything already recorded\)/);
  assert.match(out, /P1-07: source says done, imported to backlog \(verified Needs at least two new pieces of evidence, distinct from anything already recorded\)/);
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

// T-0047 — the refusal used to cite "specs §6", a file package.json does not
// ship, so the citation was unreachable from an npm install. The message now
// carries the accepted formats itself.
test('import rejects files without strict phase headings', async () => {
  const { root, store } = repo();
  const file = join(root, 'foreign-phases.md');
  writeFileSync(file, '## X1 — Work\n- **X1-01** · Item · feature · G0 · — · Scope\n');
  const streams = capture();
  await assert.rejects(
    () => run({ store, root, actor: 'human:tester', flags: {}, positionals: [file], ...streams }),
    (error) => error instanceof UsageError && error.message === 'no `## P<n> —` phase headings and no `- [ ] task` checklist lines found; gw import reads either format',
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
  assert.equal(streams.lines.join(''), 'no importable task lines found under the phase headings; task rows look like `- **ID** · title · type · gate · deps · done when`, or use a plain `- [ ] task` checklist\n');
  assert.equal(store.readItems().length, 0);
});

// T-0047 — the plain markdown checklist is the most common task format there
// is, and none of those files carry `## P<n> —` headings. They import: ids
// are minted from the board's id scheme, and a ticked box is claimed done
// but downgraded like any done claim without evidence.
test('a plain markdown checklist imports with ids minted from the board scheme', async () => {
  const { root, store } = repo();
  writeFileSync(store.paths.config, JSON.stringify({ id_scheme: 'seq' }));
  const file = join(root, 'checklist.md');
  writeFileSync(file, '# todo\n\n- [ ] first plain task\n- [x] done plain task\n');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [file], ...streams });
  assert.equal(code, 0);
  const stored = store.readItems();
  assert.deepEqual(stored.map((i) => i.id), ['T-0001', 'T-0002']);
  assert.equal(stored[0].stage, 'backlog');
  assert.equal(stored[1].stage, 'backlog', 'a ticked box is not evidence; it downgrades like any other done claim');
  assert.match(streams.lines.join(''), /T-0002: source says done, imported to backlog/);

  // Ids continue from the board, not from the file.
  const second = capture();
  writeFileSync(join(root, 'more.md'), '- [ ] another\n');
  assert.equal(await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [join(root, 'more.md')], ...second }), 0);
  assert.deepEqual(store.readItems().map((i) => i.id), ['T-0001', 'T-0002', 'T-0003']);
});

test('a checklist on a phase-seq board is refused with the way out', async () => {
  const { root, store } = repo();
  writeFileSync(store.paths.config, JSON.stringify({ id_scheme: 'phase-seq' }));
  const file = join(root, 'checklist.md');
  writeFileSync(file, '- [ ] task\n');
  await assert.rejects(
    () => run({ store, root, actor: 'human:tester', flags: {}, positionals: [file], stdout: capture().stdout }),
    (error) => error instanceof UsageError && /set id_scheme to seq with `gw config id_scheme seq`/.test(error.message),
  );
  assert.equal(store.readItems().length, 0);
});

// T-0046 — `gw edit` refuses a dependency on an id that is not on the board;
// import used to carry one through in silence, and `gw check` was the first
// to mention it. The row is skipped with its line and reason, exactly like a
// row with an invalid type.
test('a dependency on an unknown id is skipped with a reason, like any bad row', async () => {
  const { root, store } = repo();
  const path = join(root, 'deps.json');
  writeFileSync(path, '[{"id":"J-1","title":"Good","deps":["J-2"]},{"id":"J-2","title":"Target"},{"id":"J-3","title":"Dangling","deps":["T-9999"]}]');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  assert.deepEqual(store.readItems().map((i) => i.id), ['J-1', 'J-2']);
  assert.deepEqual(store.readItems().find((i) => i.id === 'J-1').deps, ['J-2'], 'a dep on a real id still imports');
  assert.match(streams.lines.join(''), /skipped line 3: unknown dependency: T-9999\n$/);
});

test('a dep on a row that was itself skipped is skipped too', async () => {
  const { root, store } = repo();
  const path = join(root, 'cascade.json');
  writeFileSync(path, '[{"id":"J-1","title":"Good"},{"id":"J-2","title":"Bad","type":"bogus"},{"id":"J-3","title":"Depends on bad","deps":["J-2"]}]');
  const streams = capture();
  const code = await run({ store, root: store.root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  assert.deepEqual(store.readItems().map((i) => i.id), ['J-1']);
  assert.match(streams.lines.join(''), /skipped line 3: unknown dependency: J-2/);
});

test('an import whose every row has an unknown dep fails like any all-skipped file', async () => {
  const { root, store } = repo();
  const path = join(root, 'all-dangling.json');
  writeFileSync(path, '[{"id":"J-1","title":"Bad","deps":["NOPE"]}]');
  await assert.rejects(
    () => run({ store, root, actor: 'human:tester', flags: {}, positionals: [path], stdout: capture().stdout }),
    (error) => error instanceof UsageError && /all 1 row\(s\) were skipped \(unknown dependency: NOPE: line 1\)/.test(error.message),
  );
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

// T-0061 — the round trip whose absence let the bug ship: export from a real
// board through the binary, import into a fresh one, and the item must land
// where the source said, with the evidence that earned it and the stage tags
// that say which gate it paid. The parser used to filter the on-disk
// `{ text, stage }` entries out entirely, so every finished item arrived at
// the initial stage with empty evidence and a message blaming the file for
// having none.
test('a gw list --json dump round-trips through import into a fresh board', () => {
  const source = mkdtempSync(join(tmpdir(), 'gw-export-'));
  const target = mkdtempSync(join(tmpdir(), 'gw-reimport-'));
  const run = (cwd, ...args) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GW_ROOT: '' } });

  run(source, 'init');
  run(source, 'add', 'round trip', '--scope', 's', '--by', 'agent:roundtrip');
  run(source, 'claim', 'T-0001', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'building', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'built', '--evidence', 'commit abc', '--by', 'agent:roundtrip');
  const dump = run(source, 'list', '--json');

  run(target, 'init');
  writeFileSync(join(target, 'dump.json'), dump);
  const out = run(target, 'import', 'dump.json');
  assert.match(out, /imported 1, skipped 0/);
  assert.doesNotMatch(out, /imported to backlog/, 'no downgrade: the dump carried the evidence that earns built');

  const imported = createStore(target).readItems().find((i) => i.id === 'T-0001');
  assert.equal(imported.stage, 'built');
  assert.deepEqual(imported.evidence, [{ text: 'commit abc', stage: 'built' }]);
  assert.equal(imported.owner, 'agent:roundtrip', 'the claim that earned the building gate survives too');
});

// The gate tags are per entry: a dump of an item that paid four gates across
// three stages must re-enter them all, not arrive as an unearned claim.
test('a verified item with four evidence entries across three stages round-trips intact', () => {
  const source = mkdtempSync(join(tmpdir(), 'gw-export-'));
  const target = mkdtempSync(join(tmpdir(), 'gw-reimport-'));
  const run = (cwd, ...args) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GW_ROOT: '' } });

  run(source, 'init');
  run(source, 'add', 'deep', '--scope', 'what done looks like', '--by', 'agent:roundtrip');
  run(source, 'claim', 'T-0001', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'building', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'built', '--evidence', 'commit def', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'in_review', '--evidence', 'https://github.com/a/b/pull/1', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'reviewed', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'merged', '--by', 'agent:roundtrip');
  run(source, 'move', 'T-0001', 'verified', '--evidence', 'checked on staging', '--evidence', 'VALIDATION log', '--by', 'agent:roundtrip');
  const dump = run(source, 'list', '--json');

  run(target, 'init');
  writeFileSync(join(target, 'dump.json'), dump);
  const out = run(target, 'import', 'dump.json');
  assert.match(out, /imported 1, skipped 0/);

  const imported = createStore(target).readItems().find((i) => i.id === 'T-0001');
  assert.equal(imported.stage, 'verified');
  assert.deepEqual(imported.evidence, [
    { text: 'commit def', stage: 'built' },
    { text: 'https://github.com/a/b/pull/1', stage: 'in_review' },
    { text: 'checked on staging', stage: 'verified' },
    { text: 'VALIDATION log', stage: 'verified' },
  ]);
});

// T-0061 — a dump legitimately satisfies the gates it already paid, but
// import must not become a way to claim a stage whose gate was never met. A
// hand-written row carrying evidence tagged for some other stage faces the
// real gate, and the downgrade message says what is actually missing — not
// that the file lacked evidence.
test('a hand-written row claiming an unearned stage downgrades with the honest reason', async () => {
  const { root, store } = repo();
  const path = join(root, 'claimed.json');
  writeFileSync(path, '[{"id":"J-1","title":"Claimed","stage":"built","scope":"s","evidence":[{"text":"made up","stage":"backlog"}]}]');
  const streams = capture();
  const code = await run({ store, root, actor: 'human:tester', flags: {}, positionals: [path], ...streams });
  assert.equal(code, 0);
  const stored = store.readItems().find((i) => i.id === 'J-1');
  assert.equal(stored.stage, 'backlog');
  assert.deepEqual(stored.evidence, [{ text: 'made up', stage: 'backlog' }], 'the entry is kept, tagged for the stage it named');
  assert.match(streams.lines.join(''), /J-1: source says built, imported to backlog \(built Needs at least one new piece of evidence, distinct from anything already recorded\)/);
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
