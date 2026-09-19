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

function root() { return mkdtempSync(join(tmpdir(), 'gw-setup-')); }
function read(cwd, name) { return JSON.parse(readFileSync(join(cwd, '.gatewright', name), 'utf8')); }
function ctxFor(cwd, { stdin, stdout, flags = {}, env = {} } = {}) {
  return { cwd, flags, positionals: [], env, stdin: stdin ?? new PassThrough(), stdout: stdout ?? { write() {} }, stderr: { write() {} } };
}

test('non-interactive init chooses the solo preset when there is no GitHub origin', async () => {
  const cwd = root();
  await init(ctxFor(cwd));
  const stages = read(cwd, 'stages.json');
  assert.deepEqual(stages.stages.map((stage) => stage.id), ['backlog', 'building', 'done']);
  assert.equal(isTerminalStage('done', stages), true);
  assert.deepEqual(read(cwd, 'config.json').policy.triage_required_for, []);
});

test('--yes never prompts, even with a terminal attached', async () => {
  const cwd = root();
  const { input, output, remaining } = fakeTty(['2']);
  await init(ctxFor(cwd, { stdin: input, stdout: output, flags: { yes: true } }));
  assert.equal(remaining(), 1, 'init must consume no scripted input under --yes');
  assert.deepEqual(read(cwd, 'config.json').policy.triage_required_for, []);
});

test('interactive init asks exactly one workflow question and can choose team', async () => {
  const cwd = root();
  const { input, output, remaining, read: transcript } = fakeTty(['2']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.equal(remaining(), 0);
  assert.match(transcript(), /Choose a workflow/);
  assert.deepEqual(read(cwd, 'stages.json').stages.map((stage) => stage.id), shipped.stages.map((stage) => stage.id));
  assert.deepEqual(read(cwd, 'config.json').policy.triage_required_for, ['agent']);
});

test('the explicit pipeline flag selects team without prompting', async () => {
  const cwd = root();
  await init(ctxFor(cwd, { flags: { pipeline: 'team', yes: true } }));
  assert.equal(isTerminalStage('verified', read(cwd, 'stages.json')), true);
});

test('trunkStages remains a compatible migration helper for existing boards', () => {
  const trunk = trunkStages(shipped);
  assert.deepEqual(trunk.stages.map((stage) => stage.id), ['backlog', 'building', 'built']);
  assert.equal(isTerminalStage('built', trunk), true);
});
