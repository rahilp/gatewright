import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run as init } from '../lib/commands/init.js';
import { trunkStages } from '../lib/tui/setup.js';
import { isTerminalStage } from '../lib/stages.js';
import { fakeTty } from './fixtures/tty.js';
import shipped from '../templates/stages.json' with { type: 'json' };

function root() {
  return mkdtempSync(join(tmpdir(), 'gw-setup-'));
}

function read(cwd, name) {
  return JSON.parse(readFileSync(join(cwd, '.gatewright', name), 'utf8'));
}

function ctxFor(cwd, { stdin, stdout, flags = {}, env = {} } = {}) {
  return {
    cwd, flags, positionals: [], env,
    stdin: stdin ?? new PassThrough(),
    stdout: stdout ?? { write() {} },
    stderr: { write() {} },
  };
}

test('a non-interactive init writes the shipped stages untouched', async () => {
  const cwd = root();
  await init(ctxFor(cwd));
  assert.deepEqual(read(cwd, 'stages.json'), shipped, 'agents and CI must see exactly what they saw before the wizard existed');
});

test('--yes skips the walkthrough even with a terminal attached', async () => {
  const cwd = root();
  const { input, output, remaining } = fakeTty(['1', '1', 'P0,P1', 'n']);
  await init(ctxFor(cwd, { stdin: input, stdout: output, flags: { yes: true } }));
  assert.deepEqual(read(cwd, 'stages.json'), shipped);
  assert.equal(remaining(), 4, 'not one scripted answer was consumed');
});

test('choosing the trunk workflow ends the pipeline at built and marks it done', async () => {
  const cwd = root();
  // workflow 1 (trunk), ids 1 (phase-seq), phases default, runner n
  const { input, output } = fakeTty(['1', '1', '', 'n']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  const stages = read(cwd, 'stages.json');
  assert.deepEqual(stages.stages.map((stage) => stage.id), ['backlog', 'building', 'built']);
  assert.equal(stages.stages.at(-1).role, 'done');
  assert.equal(isTerminalStage('built', stages), true, 'finished work must not read as still in flight');
  assert.equal(read(cwd, 'config.json').runner.enabled, false);
});

test('choosing the review workflow keeps the full pipeline', async () => {
  const cwd = root();
  const { input, output } = fakeTty(['2', '1', '', 'n']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.deepEqual(read(cwd, 'stages.json').stages.map((stage) => stage.id), shipped.stages.map((stage) => stage.id));
  assert.equal(isTerminalStage('built', read(cwd, 'stages.json')), false);
});

test('the sequential id scheme is recorded and skips the phase question', async () => {
  const cwd = root();
  // Only three answers: choosing seq must not ask for phases. A fourth prompt
  // would consume nothing and the wizard would stall, which is the assertion.
  const { input, output, remaining } = fakeTty(['1', '2', 'n']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.equal(read(cwd, 'config.json').id_scheme, 'seq');
  assert.equal(remaining(), 0);
});

test('custom phases are saved as a list', async () => {
  const cwd = root();
  const { input, output } = fakeTty(['1', '1', 'discovery, build, launch', 'n']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.deepEqual(read(cwd, 'config.json').vocab.phase, ['discovery', 'build', 'launch']);
});

// The runner spawns real processes that cost real money. Someone running `gw
// init` to look around must never end up with that armed by pressing enter.
test('the runner stays off when the enable question is defaulted', async () => {
  const cwd = root();
  const { input, output } = fakeTty(['1', '1', '', '']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.equal(read(cwd, 'config.json').runner.enabled, false);
});

test('enabling the runner records the chosen provider', async () => {
  const cwd = root();
  const { input, output, read: transcript } = fakeTty(['1', '1', '', 'y', '2']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  const runner = read(cwd, 'config.json').runner;
  assert.equal(runner.enabled, true);
  assert.equal(runner.provider, Object.keys(runner.providers)[1]);
  assert.match(transcript(), /`gw stop --all` stops everything/, 'the kill switch is stated where it is armed');
});

test('aborting the walkthrough leaves a working board on the shipped defaults', async () => {
  const cwd = root();
  const { input, output, read: transcript } = fakeTty();
  input.end();
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.deepEqual(read(cwd, 'stages.json'), shipped, 'the defaults are a working board, not a half-configured one');
  assert.match(transcript(), /setup cancelled/);
});

test('trunkStages keeps stage ids and rules identical to the shipped pipeline', () => {
  const trunk = trunkStages(shipped);
  for (const stage of trunk.stages) {
    const original = shipped.stages.find((candidate) => candidate.id === stage.id);
    assert.deepEqual(stage.requires, original.requires, `${stage.id} keeps its exit rules, so the two shapes stay comparable`);
  }
  assert.equal(trunk.terminal.includes('verified'), false, 'a stage the pipeline no longer has cannot be terminal');
  assert.deepEqual(trunk.extra, shipped.extra);
});
