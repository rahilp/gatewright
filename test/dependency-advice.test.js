import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { runPrintedCommand } from './helpers/printed-command.js';

// T-0111 — a dependency refusal printed ``Move them with `gw move <id> built` ``:
// a placeholder instead of an id, the final boundary instead of a move the
// dependency could make, and no --evidence for a gate that needed it. Every
// case here reads the real binary's refusal and runs what it printed.
const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const ACTOR = { ...process.env, GW_ACTOR: 'human:dep-test' };
const ME = 'human:dep-test';

const STAGES = {
  stages: [
    { id: 'backlog' },
    { id: 'specified', requires: { scope: true } },
    { id: 'building', requires: { owner: true } },
    // Two pieces, so advice with one --evidence would loop forever.
    { id: 'built', requires: { evidence_min: 2 } },
    { id: 'review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+$' } },
    { id: 'done', requires: { deps_at_least: 'built' } },
  ],
  terminal: ['done', 'dropped'],
  extra: [{ id: 'paused' }, { id: 'dropped' }],
};

const item = (id, over = {}) => ({
  id, title: id, stage: 'backlog', scope: '', owner: null, flag: null,
  deps: [], evidence: [], updated: new Date().toISOString(), ...over,
});

// The item whose move to done is refused: it has cleared every gate but deps.
const parent = (deps) => item('T-0001', {
  stage: 'review', scope: 'x', owner: ME, deps,
  evidence: [{ text: 'a', stage: 'built' }, { text: 'b', stage: 'built' }, { text: 'https://github.com/acme/gw/pull/1', stage: 'review' }],
});

function board(items, stages = STAGES) {
  const root = mkdtempSync(join(tmpdir(), 'gw-dependency-advice-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, '{}');
  store.rebaselineDigest();
  return { root, store };
}

function refusal(root, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env: ACTOR, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, `expected gw ${args.join(' ')} to refuse`);
  return `${result.stdout}${result.stderr}`;
}

const commands = (output) => [...output.matchAll(/`(gw [^`]+)`/g)].map((match) => match[1]);
const commandsFor = (output, id) => commands(output).filter((command) => command.split(' ')[2] === id);
const stageOf = (store, id) => store.readItems().find((entry) => entry.id === id)?.stage;

function run(root, command, substitutions = {}) {
  const text = Object.entries(substitutions).reduce((line, [from, to]) => line.replaceAll(from, to), command);
  const result = runPrintedCommand(root, text, ACTOR);
  assert.equal(result.status, 0, `${text}\n${result.stdout}\n${result.stderr}`);
}

test('a dependency refusal names real ids, never a <id> placeholder', () => {
  const b = board([parent(['T-0002']), item('T-0002', { stage: 'building', scope: 'x', owner: ME })]);
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  assert.doesNotMatch(out, /<id>/);
  assert.match(out, /dependencies must be at least built: T-0002\./);
  assert.ok(commandsFor(out, 'T-0002').length, out);
});

test('a dependency whose next gate needs evidence gets the evidence form, and it runs', () => {
  const b = board([parent(['T-0002']), item('T-0002', { stage: 'building', scope: 'x', owner: ME })]);
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  const printed = commandsFor(out, 'T-0002');
  assert.deepEqual(printed, ['gw move T-0002 built --evidence "new evidence 1" --evidence "new evidence 2"'], out);
  run(b.root, printed[0]);
  assert.equal(stageOf(b.store, 'T-0002'), 'built');
  run(b.root, 'gw move T-0001 done');
});

test('each of several dependencies gets its own advice, and every printed command succeeds', () => {
  const b = board([
    parent(['T-0002', 'T-0003', 'T-0004']),
    item('T-0002', { stage: 'building', scope: 'x', owner: ME }),
    // Short of the boundary by several stages: the advice is its next step,
    // including the scope that step needs, not a jump to built.
    item('T-0003'),
    // Forced past its owner gate: the claim comes first.
    item('T-0004', { stage: 'building', scope: 'x' }),
  ]);
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  assert.doesNotMatch(out, /<id>/);
  assert.deepEqual(commandsFor(out, 'T-0002'), ['gw move T-0002 built --evidence "new evidence 1" --evidence "new evidence 2"'], out);
  assert.deepEqual(commandsFor(out, 'T-0003'), ['gw edit T-0003 --scope "<what done looks like>"', 'gw move T-0003 specified'], out);
  assert.match(out, /T-0003 \(in backlog; specified is its next step toward built\)/);
  assert.deepEqual(commandsFor(out, 'T-0004'), ['gw claim T-0004', 'gw move T-0004 built --evidence "new evidence 1" --evidence "new evidence 2"'], out);
  for (const id of ['T-0002', 'T-0003', 'T-0004']) {
    for (const command of commandsFor(out, id)) run(b.root, command, { '<what done looks like>': 'a scoped outcome' });
  }
  assert.equal(stageOf(b.store, 'T-0002'), 'built');
  assert.equal(stageOf(b.store, 'T-0003'), 'specified');
  assert.equal(stageOf(b.store, 'T-0004'), 'built');
});

test('a pattern gate and a count gate on one stage merge into one runnable move', () => {
  const stages = structuredClone(STAGES);
  stages.stages[3].requires = { evidence_min: 2, evidence_match: '^https://github.com/.+/pull/\\d+$' };
  const blocked = parent(['T-0002']);
  blocked.evidence[1].text = 'https://github.com/acme/gw/pull/0';
  const b = board([blocked, item('T-0002', { stage: 'building', scope: 'x', owner: ME })], stages);
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  const [printed, ...rest] = commandsFor(out, 'T-0002');
  assert.equal(rest.length, 0, out);
  assert.match(printed, /^gw move T-0002 built --evidence "new evidence 1" --evidence "new evidence 2" --evidence <pull-request url>$/);
  run(b.root, printed, { '<pull-request url>': 'https://github.com/acme/gw/pull/2' });
  assert.equal(stageOf(b.store, 'T-0002'), 'built');
});

test('a dependency blocked for another reason is said plainly, with no command that would fail', () => {
  const b = board([
    parent(['T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0006']),
    item('T-0002', { stage: 'building', scope: 'x', owner: 'human:someone-else' }),
    item('T-0003', { flag: 'needs-triage', created_by: 'agent:maker' }),
    item('T-0004', { stage: 'paused', scope: 'x' }),
    // Forced into built with no evidence: no forward move repairs that gate.
    item('T-0005', { stage: 'built', scope: 'x', owner: ME }),
    // Its own dependency is short of the boundary.
    item('T-0006', { stage: 'building', scope: 'x', owner: ME, deps: ['T-0003'] }),
  ], { ...STAGES, stages: STAGES.stages.map((stage) => ({
    built: { ...stage, requires: { evidence_min: 2, deps_at_least: 'building' } },
    done: { ...stage, requires: { deps_at_least: 'review' } },
  })[stage.id] ?? stage) });
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  assert.doesNotMatch(out, /<id>/);
  for (const id of ['T-0002', 'T-0003', 'T-0004', 'T-0005', 'T-0006']) {
    assert.deepEqual(commandsFor(out, id), [], `${id} is blocked, so no command is printed for it:\n${out}`);
  }
  assert.match(out, /T-0002 is owned by human:someone-else/);
  assert.match(out, /T-0003 is held for triage/);
  assert.match(out, /T-0004 is in paused, outside the pipeline/);
  assert.match(out, /T-0005 \(in built\) cannot move to review yet: built: Needs at least two new pieces of evidence/);
  assert.match(out, /T-0006 \(in building; built is its next step toward review\) cannot move to built yet: built: dependencies must be at least building: T-0003\./);
});

test('a dropped or missing dependency is named, and the printed edit removes only those', () => {
  const b = board([
    parent(['T-0002', 'T-0003', 'T-0009']),
    item('T-0002', { stage: 'building', scope: 'x', owner: ME }),
    item('T-0003', { stage: 'dropped' }),
  ]);
  const out = refusal(b.root, ['move', 'T-0001', 'done']);
  assert.match(out, /T-0003 is dropped and will never reach built\./);
  assert.match(out, /T-0009 is not on the board\./);
  const edit = commandsFor(out, 'T-0001').find((command) => command.startsWith('gw edit '));
  assert.equal(edit, 'gw edit T-0001 --deps T-0002', out);
  run(b.root, edit);
  assert.deepEqual(b.store.readItems().find((entry) => entry.id === 'T-0001').deps, ['T-0002']);
});
