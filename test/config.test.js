import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { run as config } from '../lib/commands/config.js';
import { isInteractive } from '../lib/tui/prompt.js';

function board(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-config-'));
  const store = createStore(root);
  store.ensure();
  writeFileSync(store.paths.config, JSON.stringify({
    id_scheme: 'phase-seq',
    runner: { provider: 'claude', providers: { claude: { cmd: ['claude'] } }, max_concurrent: 1 },
    ...overrides,
  }, null, 2));
  return { root, store };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, read: () => text };
}

// A terminal is simulated rather than borrowed: node --test does not give the
// suite a TTY, and a test that depended on one would be skipped exactly where
// this behaviour matters most.
function tty(scripted = []) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  // Answers are fed one at a time in response to a prompt, not written up
  // front. readline emits a 'line' event for every buffered line the moment it
  // attaches, and question() consumes only the first -- so a pre-filled buffer
  // loses every answer after the first and the wizard stalls forever.
  const queue = [...scripted];
  output.on('data', (chunk) => {
    text += chunk;
    if (/: $/.test(String(chunk)) && queue.length) {
      const next = queue.shift();
      setImmediate(() => input.write(`${next}\n`));
    }
  });
  return { input, output, read: () => text };
}

function ctxFor({ store, positionals = [], flags = {}, env = {}, stdin, stdout = capture() }) {
  return { store, positionals, flags, env, stdin, stdout };
}

test('a non-interactive gw config lists settings instead of waiting for a human', async () => {
  const { store } = board();
  const stdout = capture();
  // No stdin at all, which is what a CI runner or an agent shell looks like.
  const code = await config(ctxFor({ store, stdout, stdin: new PassThrough() }));
  assert.equal(code, 0);
  assert.match(stdout.read(), /runner\.enabled\s+\(unset\)/);
  assert.match(stdout.read(), /runner\.max_concurrent\s+1/);
});

test('CI is treated as non-interactive even when it hands out a TTY', () => {
  const { input, output } = tty();
  assert.equal(isInteractive({ flags: {}, env: { CI: 'true' }, input, output }), false);
  assert.equal(isInteractive({ flags: {}, env: {}, input, output }), true);
  assert.equal(isInteractive({ flags: { yes: true }, env: {}, input, output }), false);
  assert.equal(isInteractive({ flags: {}, env: { GW_NO_INPUT: '1' }, input, output }), false);
});

test('setting a value writes it and reports the restart the change needs', async () => {
  const { store } = board();
  const stdout = capture();
  const code = await config(ctxFor({ store, positionals: ['runner.enabled', 'true'], stdout }));
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(store.paths.config, 'utf8')).runner.enabled, true);
  assert.match(stdout.read(), /Restart `gw serve`/);
});

test('an out-of-range value and an unknown key are both refused before anything is written', async () => {
  const { store } = board();
  const before = readFileSync(store.paths.config, 'utf8');
  await assert.rejects(() => config(ctxFor({ store, positionals: ['runner.max_concurrent', '0'] })), /at least 1/);
  await assert.rejects(() => config(ctxFor({ store, positionals: ['nope.key', '1'] })), /unknown setting/);
  await assert.rejects(() => config(ctxFor({ store, positionals: ['runner.enabled', 'perhaps'] })), /boolean/);
  assert.equal(readFileSync(store.paths.config, 'utf8'), before, 'a refused write leaves the file byte-identical');
});

test('the provider choice is constrained to providers that actually exist', async () => {
  const { store } = board();
  await assert.rejects(() => config(ctxFor({ store, positionals: ['runner.provider', 'gemini'] })), /must be one of: claude/);
});

test('the interactive editor walks every setting and saves what was answered', async () => {
  const { store } = board();
  // One answer per setting, in declaration order: booleans take y/n, the
  // provider select takes a number, the rest take a literal value.
  const { input, output, read } = tty(['y', '1', '3', '5', '60', '30', 'n', 'n', '2', '2', '1', 'n']);
  const code = await config(ctxFor({ store, stdin: input, stdout: output, env: {} }));
  assert.equal(code, 0);
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.equal(saved.runner.enabled, true);
  assert.equal(saved.runner.max_concurrent, 3);
  assert.equal(saved.policy.max_children_per_item, 2);
  assert.match(read(), /Saved to \.gatewright\/config\.json/);
});

test('aborting the editor leaves the config byte-identical', async () => {
  const { store } = board();
  const before = readFileSync(store.paths.config, 'utf8');
  // Close the stream with no answers: readline resolves question() with null
  // on EOF, which is how Ctrl-D and a vanished terminal both present.
  const { input, output, read } = tty();
  input.end();
  const code = await config(ctxFor({ store, stdin: input, stdout: output, env: {} }));
  assert.equal(code, 1, 'an abort is not a success');
  assert.equal(readFileSync(store.paths.config, 'utf8'), before);
  assert.match(read(), /nothing was changed/);
});
