import test from 'node:test';
import assert from 'node:assert/strict';
import { runRouter } from '../lib/cli/router.js';

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, read: () => text };
}

async function invoke(argv) {
  const stdout = capture(); const stderr = capture();
  const code = await runRouter(argv, { stdout, stderr, cwd: process.cwd(), env: {} });
  return { code, out: stdout.read(), err: stderr.read() };
}

// The flag set used to be discoverable only by reading source: `gw help add`
// and `gw add --help` both printed the top-level command list.
test('gw help <command> describes that command, not the whole CLI', async () => {
  const { code, out } = await invoke(['help', 'move']);
  assert.equal(code, 0);
  assert.match(out, /^gw move —/);
  assert.match(out, /usage: gw move <id> <stage>/);
  assert.match(out, /--evidence/);
  assert.doesNotMatch(out, /evidence-gated work tracking/, 'the global banner means it fell back to the global help');
});

test('gw <command> --help is the same request and gets the same answer', async () => {
  const viaHelp = await invoke(['help', 'add']);
  const viaFlag = await invoke(['add', '--help']);
  assert.equal(viaFlag.code, 0);
  assert.equal(viaFlag.out, viaHelp.out);
});

// --help must be answered before parseArgs, which rejects unknown flags -- and
// it must never let the command run.
test('--help on a command that needs arguments neither errors nor executes', async () => {
  const { code, out, err } = await invoke(['add', '--help']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.doesNotMatch(out, /title must be|required/i);
});

test('the rendered usage reflects required and optional positionals', async () => {
  const add = await invoke(['add', '--help']);
  assert.match(add.out, /usage: gw add <title>/, 'a required positional is angle-bracketed');
  const config = await invoke(['config', '--help']);
  assert.match(config.out, /usage: gw config \[<key>\] \[<value>\]/, 'an optional one is square-bracketed');
});

test('bare help and --help still print the global list', async () => {
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const { code, out } = await invoke(argv);
    assert.equal(code, 0);
    assert.match(out, /evidence-gated work tracking/);
  }
});

test('help for a command that does not exist is a usage error', async () => {
  const { code, err } = await invoke(['help', 'nonsense']);
  assert.equal(code, 2);
  assert.match(err, /unknown command 'nonsense'/);
});

test('a command that runs without a board says so', async () => {
  const { out } = await invoke(['init', '--help']);
  assert.match(out, /Runs outside an initialized board/);
});
