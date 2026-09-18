import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const foreignStages = {
  stages: [
    { id: 'icebox', label: 'Icebox' },
    { id: 'speccing', label: 'Speccing' },
    { id: 'coding', label: 'Coding', requires: { owner: true } },
    { id: 'shipped', label: 'Shipped', requires: { evidence_min: 1 } },
  ],
  terminal: ['shipped'],
  extra: [{ id: 'binned', label: 'Binned', role: 'dropped' }],
};

function run(root, args) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
}

test('the full binary workflow uses a foreign pipeline exclusively', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-custom-pipeline-'));
  run(root, ['init']);
  const store = createStore(root);
  writeFileSync(store.paths.stages, JSON.stringify(foreignStages));

  const output = [];
  output.push(run(root, ['add', 'Ship the first item']));
  assert.equal(store.readItems().find((item) => item.id === 'T-0001').stage, 'icebox');
  // T-0068 — agent-created capture is held for triage and the hold now gates
  // pipeline advancement; the workflow approves it before working the item.
  output.push(run(root, ['triage', 'T-0001', '--approve', '--force']));
  output.push(run(root, ['claim', 'T-0001']));
  output.push(run(root, ['move', 'T-0001', 'speccing']));
  output.push(run(root, ['move', 'T-0001', 'coding']));
  assert.throws(
    () => run(root, ['move', 'T-0001', 'shipped']),
    (error) => error.status === 1 && /Needs at least one new piece of evidence/.test(error.stderr),
  );
  output.push(run(root, ['move', 'T-0001', 'shipped', '--evidence', 'commit:abc123']));

  const markdown = join(root, 'import.md');
  writeFileSync(markdown, '## P0 — Imported\n- **P0-03** · Checked item · feature · G0 · T-0002 · Done ✅\n');
  output.push(run(root, ['add', 'Bin the dependency']));
  output.push(run(root, ['move', 'T-0002', 'binned']));
  output.push(run(root, ['import', markdown]));
  const imported = store.readItems().find((item) => item.id === 'P0-03');
  assert.equal(imported.stage, 'icebox');
  assert.deepEqual(imported.deps, ['T-0002']);

  let checkFailure;
  try {
    run(root, ['check']);
  } catch (error) {
    checkFailure = error;
  }
  assert.equal(checkFailure?.status, 1);
  const checkOutput = checkFailure.stdout;
  assert.match(checkOutput, /P0-03/);
  assert.match(checkOutput, /T-0002/);
  output.push(run(root, ['brief']));

  const emitted = output.join('');
  assert.match(emitted, /source says done, imported to icebox \(shipped Needs at least one new piece of evidence, distinct from anything already recorded\)/);
  assert.match(emitted, /Gates ask for evidence where a stage's rules require it: `gw next <id>` names the gate\. Never edit/);
  assert.doesNotMatch(emitted, /needs evidence past/, 'the footer must not name a stage on a custom pipeline either (T-0038)');
  assert.doesNotMatch(emitted, /backlog|verified|dropped/);
  assert.doesNotMatch(checkOutput, /backlog|verified/);
  assert.equal(readFileSync(store.paths.stages, 'utf8').includes('paused'), false);
});

test('a pipeline without a dropped role never reports a dropped dependency', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-no-dropped-role-'));
  run(root, ['init']);
  const store = createStore(root);
  writeFileSync(store.paths.stages, JSON.stringify({ ...foreignStages, extra: [] }));
  store.writeItems([
    // T-0071 — shape is validated against the board's stages, so the dependency
    // sits at a stage this pipeline defines (the subject here is that no
    // dropped role means no dropped-dependency report, not orphaned stages).
    { id: 'P0-01', title: 'Dependent', stage: 'icebox', flag: null, owner: null, deps: ['P0-02'], evidence: [], updated: new Date().toISOString() },
    { id: 'P0-02', title: 'Former side state', stage: 'speccing', flag: null, owner: null, deps: [], evidence: [], updated: new Date().toISOString() },
  ]);
  assert.equal(run(root, ['check']), 'Board is clean.\n');
});
