import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function rawTty({ columns = 88 } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = (value) => raw.push(value);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = columns;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { input, output, raw, read: () => text };
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

// Keys are written one per tick, as a terminal would deliver them, so each
// screen is drawn before its answer arrives.
async function keys(tty, ...sequence) {
  for (const key of sequence) {
    await new Promise((resolve) => setImmediate(resolve));
    tty.input.write(key);
  }
}

test('rich init asks the workflow once, then options and a review, and never writes before Enter on the review', async () => {
  const cwd = root();
  const tty = rawTty();
  const run = init(ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color', NO_COLOR: '1' } }));
  await keys(tty, '\x1b[B', '\r');
  // Focus starts on the first optional row (Claude); Space ticks it.
  await keys(tty, ' ', '\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(existsSync(join(cwd, '.gatewright')), false, 'nothing is written while the review screen is up');
  await keys(tty, '\r');
  assert.equal(await run, 0);
  const screen = tty.read();
  assert.equal(screen.match(/How does work reach main\?/g)?.length > 0, true);
  assert.doesNotMatch(screen, /Choose a workflow/, 'the workflow is asked once, in one wording');
  assert.match(screen, /Step 1 of 3/);
  assert.match(screen, /What should init set up\?/);
  assert.match(screen, /Create the board\?/);
  assert.match(screen, /CLAUDE\.md/);
  assert.match(screen, /Board ready/);
  assert.doesNotMatch(screen, /\x1b\[[0-9;]*m/, 'NO_COLOR suppresses every colour sequence');
  assert.deepEqual(read(cwd, 'config.json').policy.triage_required_for, ['agent']);
  assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'ticking Claude with Space mirrors the block into CLAUDE.md');
  assert.deepEqual(tty.raw, [true, false], 'raw mode is entered once and given back before init writes');
  assert.match(screen, /\x1b\[\?25h\x1b\[\?1049l/, 'the cursor and the normal screen are restored');
});

// What init prints once the full-screen walkthrough has handed the normal
// screen back: everything after the last "leave alternate screen".
function afterScreens(text) { return text.slice(text.lastIndexOf('\x1b[?1049l') + '\x1b[?1049l'.length); }

function gitRoot() {
  const cwd = root();
  mkdirSync(join(cwd, '.git'));
  writeFileSync(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return cwd;
}

// Stands in for `gw hook install`, printing what the real one prints plus the
// guard-probe warning, which is exactly the kind of line the box must not lose.
function hookRun(context) {
  context.stdout.write('gw: installed the commit-msg hook at .git/hooks/commit-msg\n');
  context.stdout.write('gw: commits must now name, claim, or branch on an item. `git commit --no-verify` still bypasses it, by design.\n');
  context.stdout.write('gw: WARNING — the guard probe failed: the gw this hook would call does not answer `gw guard --help`.\n');
}

test('after the full-screen walkthrough the Board ready box is the whole report', async () => {
  const cwd = gitRoot();
  const tty = rawTty({ columns: 80 });
  const run = init({ ...ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color', NO_COLOR: '1' } }), hookRun });
  await keys(tty, '\x1b[B', '\r', '\r', '\r');
  assert.equal(await run, 0);
  const report = afterScreens(tty.read());
  assert.doesNotMatch(report, /^gw: /m, 'no log line is printed alongside the box');
  assert.doesNotMatch(report, /^Next: `gw add/m);
  assert.equal(report.match(/Board ready/g)?.length, 1);
  assert.match(report, /Team pipeline: backlog → building → built → in review → reviewed → merged/);
  assert.match(report, /PR review and triage are on/);
  assert.match(report, /Commit hook installed at \.git\/hooks\/commit-msg/);
  assert.match(report, /`git commit --no-verify` bypasses it; `gw hook uninstall` removes it/);
  assert.match(report, /gw open {4}a snapshot instead/);
  assert.match(report, /Notes:[\s\S]*WARNING — the guard probe failed/, 'a line the box does not summarise is carried into it');
  assert.match(report, /no Claude, Cursor and Copilot project signal/);
  const lines = report.split('\n').filter(Boolean);
  assert.ok(lines.every((line) => [...line].length <= 80), `the box fits 80 columns:\n${report}`);
  assert.ok(lines.every((line) => /^[┌│└]/.test(line)), `only the box is printed:\n${report}`);
});

test('the Board ready box wraps inside its border on a narrow terminal', async () => {
  const cwd = gitRoot();
  const tty = rawTty({ columns: 50 });
  const run = init({ ...ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color', NO_COLOR: '1' } }), hookRun });
  await keys(tty, '\x1b[B', '\r', '\r', '\r');
  assert.equal(await run, 0);
  const lines = afterScreens(tty.read()).split('\n').filter(Boolean);
  assert.ok(lines.every((line) => [...line].length <= 50), lines.join('\n'));
  assert.ok(lines.every((line) => /^[┌│└]/.test(line) && /[┐│┘]$/.test(line)), lines.join('\n'));
  assert.ok(lines.some((line) => /^│ {3}in review → reviewed/.test(line)), `continuations hang under the item text:\n${lines.join('\n')}`);
});

// Agents, CI and the numbered prompt read these lines. They are pinned
// byte-for-byte so the full-screen work cannot drift them.
test('the numbered-prompt init transcript is byte-identical to the pre-TUI output', async () => {
  const cwd = root();
  const { input, output, read: transcript } = fakeTty(['2']);
  await init(ctxFor(cwd, { stdin: input, stdout: output }));
  assert.equal(transcript(), 'Choose a workflow:\n'
    + '  1) Solo\n'
    + '     Finish work locally: no pull request and no triage hold.\n'
    + '  2) Team\n'
    + '     Use pull-request review and hold agent-created work for triage.\n'
    + '  choose 1-2 [1]: gw: wrote the work-tracking block to AGENTS.md\n'
    + 'gw: no Claude, Cursor and Copilot project signal was found — add instructions later with `gw init --mirror claude,cursor,copilot`\n'
    + 'gw: initialized .gatewright/\n'
    + 'gw: pipeline: team — backlog → building → built → in review → reviewed → merged → verified; PR review and triage are on\n'
    + 'gw: change the pipeline later from the Stages view in `gw serve`\n'
    + 'gw: skipped the commit hook (not a Git repository)\n'
    + 'Next: `gw add "<title>"`, then `gw serve` for the live board (or `gw open` for a snapshot).\n');
});

test('the --yes init output is byte-identical to the pre-TUI output', async () => {
  const cwd = gitRoot();
  let out = '';
  await init({ ...ctxFor(cwd, { flags: { yes: true }, stdout: { write: (chunk) => { out += chunk; } } }), hookRun: (context) => context.stdout.write('gw: installed the commit-msg hook at .git/hooks/commit-msg\n') });
  assert.equal(out, 'gw: wrote the work-tracking block to AGENTS.md\n'
    + 'gw: no Claude, Cursor and Copilot project signal was found — add instructions later with `gw init --mirror claude,cursor,copilot`\n'
    + 'gw: initialized .gatewright/\n'
    + 'gw: pipeline: solo — backlog → building → done; no PR or triage hold\n'
    + 'gw: change the pipeline later from the Stages view in `gw serve`\n'
    + 'gw: installed the commit-msg hook at .git/hooks/commit-msg\n'
    + 'gw: the commit hook keeps commits tied to board work; remove it with `gw hook uninstall`\n'
    + 'Next: `gw add "<title>"`, then `gw serve` for the live board (or `gw open` for a snapshot).\n');
});

test('declining the review screen writes nothing', async () => {
  const cwd = root();
  const tty = rawTty();
  const run = init(ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color' } }));
  await keys(tty, '\r', '\r', 'n');
  assert.equal(await run, 1);
  assert.equal(existsSync(join(cwd, 'AGENTS.md')), false);
  assert.equal(existsSync(join(cwd, '.gatewright')), false);
});

for (const [name, key] of [['Ctrl-C', '\x03'], ['Esc', '\x1b']]) {
  test(`${name} in rich init restores the terminal and writes no setup files`, async () => {
    const cwd = root();
    const tty = rawTty();
    const run = init(ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color' } }));
    await keys(tty, '\r', key);
    assert.equal(await run, 1);
    assert.deepEqual(tty.raw, [true, false]);
    assert.match(tty.read(), /\x1b\[\?25h/);
    assert.match(tty.read(), /setup cancelled — nothing was written/);
    assert.equal(existsSync(join(cwd, 'AGENTS.md')), false, 'the instruction file was never opened for writing');
    assert.equal(existsSync(join(cwd, '.gatewright', 'config.json')), false);
  });
}

test('a rich terminal with --pipeline skips the workflow screen but still reviews', async () => {
  const cwd = root();
  const tty = rawTty();
  const run = init(ctxFor(cwd, { stdin: tty.input, stdout: tty.output, flags: { pipeline: 'team' }, env: { TERM: 'xterm-256color' } }));
  await keys(tty, '\r', '\r');
  assert.equal(await run, 0);
  assert.doesNotMatch(tty.read(), /How does work reach main/);
  assert.match(tty.read(), /Step 2 of 2/);
  assert.equal(isTerminalStage('verified', read(cwd, 'stages.json')), true);
});

test('TERM=dumb and GW_TUI=0 keep the numbered prompt even with raw mode available', async () => {
  for (const env of [{ TERM: 'dumb' }, { TERM: 'xterm', GW_TUI: '0' }]) {
    const cwd = root();
    const tty = rawTty();
    const run = init(ctxFor(cwd, { stdin: tty.input, stdout: tty.output, env }));
    await new Promise((resolve) => setImmediate(resolve));
    tty.input.write('2\r');
    await run;
    assert.match(tty.read(), /Choose a workflow:/);
    assert.match(tty.read(), /choose 1-2/);
    assert.doesNotMatch(tty.read(), /\x1b\[\?1049h/, 'no full-screen UI for this terminal');
    assert.deepEqual(read(cwd, 'config.json').policy.triage_required_for, ['agent']);
  }
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
