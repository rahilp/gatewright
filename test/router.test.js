import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRouter } from '../lib/cli/router.js';

function io() { let out = ''; let err = ''; return { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } }, get out() { return out; }, get err() { return err; } }; }
function loader(module) { return async () => module; }

test('router dispatches flags to a command module and supplies root context', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-router-'));
  mkdirSync(join(root, '.gatewright'));
  const streams = io(); let received;
  const code = await runRouter(['demo', 'thing', '--by', 'agent:r'], { cwd: root, env: {}, ...streams, load: loader({ spec: { flags: { by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] }, run: (ctx) => { received = ctx; } }) });
  assert.equal(code, 0); assert.equal(received.positionals[0], 'thing'); assert.equal(received.flags.by, 'agent:r'); assert.equal(received.root, root); assert.equal(received.actor, 'agent:r');
});

test('router maps command error classes to their contract exit codes', async () => {
  const { UsageError, RuleError, IOError } = await import('../lib/cli/errors.js');
  for (const [error, code] of [[new UsageError('bad'), 2], [new RuleError('bad', ['one', 'two']), 1], [new IOError('bad'), 3]]) {
    const streams = io();
    assert.equal(await runRouter(['x'], { env: {}, ...streams, load: loader({ spec: { needsRoot: false, flags: {}, positionals: [] }, run: () => { throw error; } }) }), code);
    assert.match(streams.err, /bad/);
  }
});

test('root lookup honors GW_ROOT, stops at its boundary, and gives a useful missing-root error', async () => {
  const { findRoot, actor } = await import('../lib/cli/root.js');
  const base = mkdtempSync(join(tmpdir(), 'gw-root-')); const root = join(base, 'repo'); const nested = join(root, 'a', 'b');
  mkdirSync(join(root, '.gatewright'), { recursive: true }); mkdirSync(nested, { recursive: true });
  assert.equal(findRoot(nested, {}, { stopAt: base }), root); assert.equal(findRoot(base, { GW_ROOT: join(root, '.gatewright') }), root);
  assert.equal(actor({}, { USER: 'sam' }), 'human:sam');
  assert.throws(() => findRoot(base, {}, { stopAt: base }), /no .gatewright/);
});

// T-0030 — the actor convention (`agent:<name>`) must hold at the one place
// every command's actor passes through: `agent:codex` is kept, a bare
// `agent` (flag or env) is refused with the convention named, and the root
// help documents both the env var and the flag.
test('a bare agent actor is refused, agent:<name> passes, and the help says so', async () => {
  const { actor } = await import('../lib/cli/root.js');
  assert.equal(actor({ by: 'agent:codex' }, {}), 'agent:codex');
  assert.equal(actor({}, { GW_ACTOR: 'agent:opencode' }), 'agent:opencode');
  for (const [flags, env] of [[{ by: 'agent' }, {}], [{ by: 'agent:' }, {}], [{}, { GW_ACTOR: 'agent' }], [{}, { GW_ACTOR: 'agent:' }]]) {
    assert.throws(() => actor(flags, env), (error) => error.message.includes('agent:<name>'));
  }
  const help = io();
  await runRouter(['--help'], { env: {}, ...help });
  assert.match(help.out, /GW_ACTOR=agent:opencode/);
  assert.match(help.out, /--by agent:opencode/);
  assert.match(help.out, /bare "agent" is refused/);
});

test('root lookup warns when an ancestor root is outside the enclosing git repository', async () => {
  const { findRoot } = await import('../lib/cli/root.js');
  const base = mkdtempSync(join(tmpdir(), 'gw-root-warning-'));
  const gitRoot = join(base, 'repo'); const nested = join(gitRoot, 'src');
  mkdirSync(join(base, '.gatewright')); mkdirSync(nested, { recursive: true });
  const streams = io();
  assert.equal(findRoot(nested, {}, { stderr: streams.stderr, getGitRoot: () => gitRoot }), base);
  // `base` is an OS path; embedding it raw in a RegExp is unsafe on Windows
  // (its backslashes are escape introducers there, not literal separators,
  // so the compiled pattern silently loses them and never matches). A plain
  // substring check needs no escaping.
  assert.equal(streams.err.includes(`outside this git repository: ${base}`), true);
});

test('config readers use defaults for absent files and identify malformed filenames', async () => {
  const { readConfig, readStages } = await import('../lib/config.js'); const { IOError } = await import('../lib/cli/errors.js');
  const root = mkdtempSync(join(tmpdir(), 'gw-config-')); const store = { paths: { config: join(root, 'config.json'), stages: join(root, 'stages.json') } };
  assert.equal(readConfig(store).version, 1); assert.equal(readStages(store).stages[0].id, 'backlog');
  const templateConfig = JSON.parse(readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'));
  const templateStages = JSON.parse(readFileSync(new URL('../templates/stages.json', import.meta.url), 'utf8'));
  assert.deepEqual(readConfig(store), templateConfig);
  assert.deepEqual(readStages(store), templateStages);
  writeFileSync(store.paths.config, '{'); writeFileSync(store.paths.stages, '{');
  assert.throws(() => readConfig(store), (err) => err instanceof IOError && /config.json/.test(err.message));
  assert.throws(() => readStages(store), (err) => err instanceof IOError && /stages.json/.test(err.message));
});
