import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/add.js';
import { guardCommit } from '../lib/guard.js';
import { isSchedulable } from '../lib/policy.js';
import { readStages } from '../lib/config.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const HUMAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GW_ACTOR', 'CLAUDECODE', 'AI_AGENT'].includes(key)));
function repo(config = {}) { const root = mkdtempSync(join(tmpdir(), 'gw-add-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), JSON.stringify({ vocab: { phase: ['P1', 'P2'] }, policy: {}, ...config })); const store = createStore(root); store.ensure(); return { root, store }; }

test('add creates a fully defaulted item and exactly one add event', () => {
  const { store } = repo(); let out = ''; const id = run({ store, root: store.root, actor: 'human:me', flags: { phase: 'P1' }, positionals: ['hello'], stdout: { write: s => { out += s; } } });
  assert.equal(id, undefined); assert.equal(out, 'P1-01\n');
  const item = store.readItems()[0]; assert.equal(item.id, 'P1-01'); assert.equal(item.stage, 'backlog'); assert.equal(item.created_by, 'human:me', 'created_by records the (qualified) actor, not the bare word "human" (T-0052)'); assert.equal(item.owner, null); assert.deepEqual(item.deps, []); assert.deepEqual(item.refs, []); assert.equal(store.readEvents().length, 1); assert.equal(store.readEvents()[0].type, 'add');
});

// P0-15 removed the item field `gate` entirely: it duplicated priority and no
// rule ever read it. A bare add must carry no trace of it, and the CLI must
// refuse the flag outright rather than silently accepting and ignoring it.
test('add creates an item with no gate key at all', () => {
  const { store } = repo();
  run({ store, root: store.root, actor: 'human:me', flags: { phase: 'P1' }, positionals: ['no gate here'], stdout: { write: () => {} } });
  const item = store.readItems()[0];
  assert.equal(Object.hasOwn(item, 'gate'), false, 'gate must not exist on a freshly created item, not even as null');
});

test('gw add --gate is rejected as an unknown flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-add-'));
  execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: root, encoding: 'utf8' });
  const result = spawnSync(process.execPath, [BIN, 'add', 'nope', '--gate', 'G0'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown flag: --gate/);
});

test('a fresh default board goes from a bare `gw add` to "working on it" in add, claim, move -- no mandatory edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-capture-'));
  execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: root, encoding: 'utf8' });
  const id = execFileSync(process.execPath, [BIN, 'add', 'Fix the login bug'], { cwd: root, encoding: 'utf8', env: HUMAN_ENV }).trim();
  assert.equal(id, 'T-0001', 'the shipped default id_scheme is seq, so a bare add needs no phase');

  const store = createStore(root);
  const created = store.readItems().find((item) => item.id === id);
  assert.equal(created.phase, null);
  assert.equal(created.type, null);
  assert.equal(created.priority, null);
  assert.equal(created.stage, 'backlog');

  // T-0113 — the capture is flagged unclassified, which keeps it off the
  // scheduler and nothing else: its creator claims and moves it with no
  // triage step. (A previous version of this test had to approve its own
  // capture first, which is the bug the README promised did not exist.)
  assert.equal(created.flag, 'unclassified');
  assert.equal(isSchedulable(created, { config: {}, stages: readStages(store), items: [created] }), false, 'kept off the scheduler until classified or approved');
  execFileSync(process.execPath, [BIN, 'claim', id], { cwd: root, encoding: 'utf8', env: HUMAN_ENV });
  execFileSync(process.execPath, [BIN, 'move', id, 'building'], { cwd: root, encoding: 'utf8', env: HUMAN_ENV });
  const building = store.readItems().find((item) => item.id === id);
  assert.equal(building.stage, 'building');
  assert.match(building.owner, /^human:/, 'claim assigns an owner with no --scope, --phase, or other edit required first');
});

// T-0113 — the other half of the same rule: an agent's capture under a
// policy that holds agent work (the team pipeline's default) is still a
// needs-triage hold, and move still refuses it.
test('an agent capture on a team board is still held: claim works, move is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-capture-agent-'));
  execFileSync(process.execPath, [BIN, 'init', '--yes', '--pipeline', 'team'], { cwd: root, encoding: 'utf8', env: HUMAN_ENV });
  const env = { ...HUMAN_ENV, GW_ACTOR: 'agent:maker' };
  const id = execFileSync(process.execPath, [BIN, 'add', 'Agent-found bug'], { cwd: root, encoding: 'utf8', env }).trim();
  assert.equal(createStore(root).readItems().find((item) => item.id === id).flag, 'needs-triage');
  const claimed = execFileSync(process.execPath, [BIN, 'claim', id], { cwd: root, encoding: 'utf8', env });
  assert.match(claimed, /held for triage: you cannot approve your own item/);
  const moved = spawnSync(process.execPath, [BIN, 'move', id, 'building'], { cwd: root, encoding: 'utf8', env });
  assert.equal(moved.status, 1);
  assert.match(moved.stderr, /held for triage \(flagged needs-triage by agent:maker\)/);
});

test('add with no flags at all produces a workable item: no phase, type or priority guessed', () => {
  const { store } = repo({ id_scheme: 'seq', vocab: null }); let out = '';
  const id = run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['Fix the login bug'], stdout: { write: s => { out += s; } } });
  assert.equal(id, undefined); assert.equal(out, 'T-0001\n');
  const item = store.readItems()[0];
  assert.equal(item.id, 'T-0001'); assert.equal(item.phase, null); assert.equal(item.type, null); assert.equal(item.priority, null);
  assert.equal(item.stage, 'backlog'); assert.equal(item.flag, 'unclassified', 'unclassified capture is kept from the scheduler, not silently marked ready');
});

test('seq config produces board-wide ids and children', () => {
  const { root } = repo({ id_scheme: 'seq', vocab: {} });
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'first'], { cwd: root, encoding: 'utf8' }), 'T-0001\n');
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'second'], { cwd: root, encoding: 'utf8' }), 'T-0002\n');
  assert.equal(execFileSync(process.execPath, [BIN, 'add', 'child', '--parent', 'T-0001'], { cwd: root, encoding: 'utf8' }), 'T-0001.1\n');
});

test('phase-seq refuses a missing phase through the real binary', () => {
  const { root } = repo({ vocab: null });
  const result = spawnSync(process.execPath, [BIN, 'add', 'no phase'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pass --phase/);
  assert.match(result.stderr, /configure vocab\.phase/);
  assert.match(result.stderr, /id_scheme.*seq/);
});

test('seq remains usable without vocabulary on the same board shape', () => {
  const { root } = repo({ id_scheme: 'seq', vocab: null });
  const result = spawnSync(process.execPath, [BIN, 'add', 'no phase needed'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'T-0001\n');
});

test('add uses the custom pipeline initial stage', () => {
  const { root, store } = repo();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'icebox', label: 'Icebox' }, { id: 'building', label: 'Building' }], terminal: [] }));
  const result = spawnSync(process.execPath, [BIN, 'add', 'custom stage item', '--phase', 'P1'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(store.readItems()[0].stage, 'icebox');
});

test('add never guesses a phase from vocabulary; phase is null unless given', () => {
  // Capture must not invent a classification: a board with a phase vocabulary
  // configured still leaves phase null when the caller does not name one.
  const configured = repo({ id_scheme: 'seq', vocab: { phase: ['Discovery', 'Delivery'] } });
  run({ store: configured.store, root: configured.root, actor: 'human:me', flags: {}, positionals: ['configured'], stdout: { write() {} } });
  assert.equal(configured.store.readItems()[0].phase, null);

  const unconfigured = repo({ id_scheme: 'seq', vocab: null });
  run({ store: unconfigured.store, root: unconfigured.root, actor: 'human:me', flags: {}, positionals: ['unconfigured'], stdout: { write() {} } });
  assert.equal(unconfigured.store.readItems()[0].phase, null);
});

test('unknown id scheme exits 2 through the real binary', () => {
  const { root } = repo({ id_scheme: 'bogus' });
  const result = spawnSync(process.execPath, [BIN, 'add', 'bad'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /phase-seq, seq/);
});

test('add through the real binary prints only the new id', () => {
  const { root } = repo(); const out = execFileSync(process.execPath, [BIN, 'add', 'binary item', '--phase', 'P2', '--by', 'agent:r1'], { cwd: root, encoding: 'utf8' }); assert.equal(out, 'P2-01\n');
});

test('agent child policy and vocabulary validation are enforced', () => {
  const { store } = repo({ vocab: { phase: ['P1'], type: ['feature'] }, policy: { max_children_per_item: 0, triage_required_for: ['agent'], auto_dispatch_children: false } }); store.writeItems([{ id: 'P1-01', parent: null }]);
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'P1-01', phase: 'P1', type: 'feature' }, positionals: ['child'], stdout: { write() {} } }), /children/i);
  assert.throws(() => run({ store, root: store.root, actor: 'human:x', flags: { phase: 'P9' }, positionals: ['bad'], stdout: { write() {} } }), /P1/);
});

test('agent creation is held, is capped per parent, and a human is not subject to the agent cap', () => {
  const { store } = repo({ policy: { max_children_per_item: 10, triage_required_for: ['agent'], auto_dispatch_children: false } });
  store.writeItems([{ id: 'P1-01', parent: null }, ...Array.from({ length: 10 }, (_, n) => ({ id: `P1-01.${n + 1}`, parent: 'P1-01' }))]);
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'P1-01' }, positionals: ['eleventh'], stdout: { write() {} } }), /P1-01.*max_children_per_item \(10\)/);
  run({ store, root: store.root, actor: 'human:lead', flags: { parent: 'P1-01' }, positionals: ['human child'], stdout: { write() {} } });
  // Not subject to the agent cap. It is still unclassified (no phase/type/priority
  // -- the parent stub carries none to inherit), so it is kept from the
  // scheduler -- but by the unclassified flag, which claim/move never consult,
  // not by the agent policy hold (T-0113).
  assert.equal(store.readItems().at(-1).flag, 'unclassified');
});

test('a fourth-generation child is refused at the default max_depth of 3', () => {
  const { store } = repo();
  store.writeItems([
    { id: 'P1-01', parent: null }, { id: 'P1-01.1', parent: 'P1-01' },
    { id: 'P1-01.1.1', parent: 'P1-01.1' }, { id: 'P1-01.1.1.1', parent: 'P1-01.1.1' },
  ]);
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'P1-01.1.1.1' }, positionals: ['too deep'], stdout: { write() {} } }), /max_depth \(3\).*P1-01\.1\.1\.1/);
});

test('agent child-creation loop terminates at the cap with every created item held and none schedulable', () => {
  const { store } = repo({ id_scheme: 'seq', policy: { max_children_per_item: 10, triage_required_for: ['agent'], auto_dispatch_children: false } });
  run({ store, root: store.root, actor: 'agent:r', flags: {}, positionals: ['root'], stdout: { write() {} } });
  for (let n = 0; n < 10; n += 1) run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'T-0001' }, positionals: [`child ${n}`], stdout: { write() {} } });
  assert.throws(() => run({ store, root: store.root, actor: 'agent:r', flags: { parent: 'T-0001' }, positionals: ['one too many'], stdout: { write() {} } }), /max_children_per_item \(10\)/);
  const items = store.readItems();
  assert.equal(items.length, 11); assert.equal(items.filter((item) => item.flag === 'needs-triage').length, 11);
  assert.equal(items.filter((item) => isSchedulable(item, { config: {}, stages: readStages(store), items })).length, 0);
});

test('add uses the shared vocabulary validation message', () => {
  const { store } = repo({ vocab: { type: ['feature'] } });
  assert.throws(
    () => run({ store, root: store.root, actor: 'human:x', flags: { type: 'defect' }, positionals: ['bad'], stdout: { write() {} } }),
    /invalid --type 'defect'; allowed values: feature/,
  );
});

test('child inherits parent\'s phase when --phase is not given', () => {
  const { store } = repo({ vocab: { phase: ['P0', 'P1', 'P2'] } });
  run({ store, root: store.root, actor: 'human:me', flags: { phase: 'P2' }, positionals: ['parent'], stdout: { write() {} } });
  run({ store, root: store.root, actor: 'human:me', flags: { parent: 'P2-01' }, positionals: ['child'], stdout: { write() {} } });
  const child = store.readItems().find((item) => item.id === 'P2-01.1');
  assert.equal(child.phase, 'P2');
});

test('explicit --phase on child still wins over parent\'s phase', () => {
  const { store } = repo({ vocab: { phase: ['P0', 'P1', 'P2'] } });
  run({ store, root: store.root, actor: 'human:me', flags: { phase: 'P2' }, positionals: ['parent'], stdout: { write() {} } });
  run({ store, root: store.root, actor: 'human:me', flags: { parent: 'P2-01', phase: 'P0' }, positionals: ['child'], stdout: { write() {} } });
  const child = store.readItems().find((item) => item.id === 'P2-01.1');
  assert.equal(child.phase, 'P0');
});

test('top-level item is unaffected by parent phase-inheritance logic', () => {
  const { store } = repo({ id_scheme: 'seq', vocab: { phase: ['P0', 'P1'] } });
  run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['top-level'], stdout: { write() {} } });
  const item = store.readItems()[0];
  assert.equal(item.phase, null, 'no parent to inherit from, and capture never guesses a phase from vocab');
  assert.equal(item.parent, null);
});

test('parent with no phase leaves the child phase null; no vocab fallback', () => {
  const { store } = repo({ id_scheme: 'seq', vocab: { phase: ['P0', 'P1'] } });
  store.writeItems([{ id: 'T-0001', phase: null, parent: null }]);
  run({ store, root: store.root, actor: 'human:me', flags: { parent: 'T-0001' }, positionals: ['child'], stdout: { write() {} } });
  const child = store.readItems().find((item) => item.parent === 'T-0001');
  assert.equal(child.phase, null);
});

// T-0009 — a newline title rendered as two list rows, the second with no id
// or stage; an empty title rendered blank everywhere. Both are refused at
// the door, so the board never stores a title its text views cannot render.
test('add refuses a title containing a newline, an empty title, and a whitespace-only title', () => {
  const { store } = repo();
  assert.throws(
    () => run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['a\nb'], stdout: { write() {} } }),
    (error) => error.message === 'title must not contain newlines',
  );
  assert.throws(
    () => run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: [''], stdout: { write() {} } }),
    (error) => error.message === 'title must not be empty',
  );
  assert.throws(
    () => run({ store, root: store.root, actor: 'human:me', flags: {}, positionals: ['   '], stdout: { write() {} } }),
    (error) => error.message === 'title must not be empty',
  );
  assert.equal(store.readItems().length, 0);
});

test('a newline title exits 2 through the real binary and never reaches the board', () => {
  const { root, store } = repo();
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'add', 'a\nb'], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 2,
  );
  assert.equal(store.readItems().length, 0);
});

// T-0052 — `--by rahil` (no prefix) is the most natural thing a person types,
// and it used to be discarded: the item recorded the bare word "human". A
// bare name is accepted as `human:<name>`; the outcome is asserted end to
// end — `gw show` reports the named human truthfully, the claim stores the
// qualified owner, and guard vouches the item for the actor it stored.
test('a bare --by name is kept as human:<name>: show reports it and guard matches the item', () => {
  const { root, store } = repo();
  execFileSync(process.execPath, [BIN, 'add', 'named human', '--phase', 'P1', '--by', 'rahil'], { cwd: root, encoding: 'utf8' });
  const shown = execFileSync(process.execPath, [BIN, 'show', 'P1-01', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(JSON.parse(shown).created_by, 'human:rahil', 'gw show must report the named human, not the bare word "human"');
  execFileSync(process.execPath, [BIN, 'claim', 'P1-01', '--by', 'rahil'], { cwd: root, encoding: 'utf8' });
  const claimed = store.readItems()[0];
  assert.equal(claimed.owner, 'human:rahil', 'the claim records the qualified owner, which is what the rest of the system compares against');
  const verdict = guardCommit({ message: 'unrelated', files: ['lib/a.js'], items: [claimed], actor: 'human:rahil', stages: readStages(store), config: {} });
  assert.equal(verdict.ok, true, 'guard must match the item for the actor the bare name produced');
  assert.equal(verdict.via, 'owner');
});

// T-0030 — the mechanism existed (`--by agent:<name>`, `GW_ACTOR=agent:<name>`)
// but nothing documented it, so agents recorded their work as done by a human.
// These pin the outcomes: a named agent actor lands in `created_by`, and a
// bare `--by agent` is refused rather than silently becoming "human".
test('an agent actor is recorded as itself, not as a human', () => {
  const { root, store } = repo();
  execFileSync(process.execPath, [BIN, 'add', 'agent-made', '--phase', 'P1', '--by', 'agent:opencode'], { cwd: root, encoding: 'utf8' });
  execFileSync(process.execPath, [BIN, 'add', 'agent-made-env', '--phase', 'P1'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GW_ACTOR: 'agent:codex' },
  });
  const items = store.readItems();
  assert.equal(items[0].created_by, 'agent:opencode');
  assert.equal(items[1].created_by, 'agent:codex');
  assert.equal(store.readEvents().every((event) => event.by === 'agent:opencode' || event.by === 'agent:codex'), true);
});

test('a bare --by agent is refused with the convention named, and stores nothing', () => {
  const { root, store } = repo();
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'add', 'bare agent', '--phase', 'P1', '--by', 'agent'], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 2 && /agent:<name>/.test(`${error.stderr}`),
  );
  assert.equal(store.readItems().length, 0);
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'add', 'empty name', '--phase', 'P1'], { cwd: root, encoding: 'utf8', env: { ...process.env, GW_ACTOR: 'agent:' } }),
    (error) => error.status === 2 && /agent:<name>/.test(`${error.stderr}`),
  );
  assert.equal(store.readItems().length, 0);
});
