import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run as config } from '../lib/commands/config.js';
import { isInteractive } from '../lib/tui/prompt.js';
import { fakeTty as tty } from './fixtures/tty.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

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

function rawTty() {
  const input = new PassThrough();
  input.isTTY = true;
  const raw = [];
  input.setRawMode = (value) => raw.push(value);
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 88;
  output.rows = 24;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { input, output, raw, read: () => text };
}

// The platform is pinned so the full-screen tests draw the same glyphs on
// every CI runner; Windows console detection is tested on its own, with
// explicit capabilities, in test/tui-prompt.test.js and test/setup.test.js.
function ctxFor({ store, positionals = [], flags = {}, env = {}, stdin, stdout = capture(), platform = 'linux' }) {
  return { store, positionals, flags, env, stdin, stdout, platform };
}

// Runs the real binary. A digest test that only asked store.verifyDigest()
// could pass while `gw check` still printed a warning; the property under
// test is the check's actual output.
function checkClean(root) {
  const out = execFileSync(process.execPath, [BIN, 'check'], { cwd: root, encoding: 'utf8' });
  assert.equal(out, 'Board is clean.\n');
}

// Every `gw config` write path goes through persist() -> store.writeConfig,
// which re-baselines the digest. A tamper report on gw's own writes would
// train people to ignore the one warning that matters, so each path is pinned
// against the real check output.

// One answer per setting, in declaration order — lib/settings.js SETTINGS is
// the order of the walk. Booleans take y/n, a select takes the choice's
// number, and everything else takes a literal value. If SETTINGS changes,
// these two tests break first; that is by design, so the wizard cannot grow a
// question that no test ever answers.
const EDITOR_ANSWERS = [
  // runner: enabled, provider, max_concurrent, tick_s, run_timeout_min,
  // stop_timeout_s, paused, prompt_template, worktree_root
  'y', '1', '3', '5', '60', '30', 'n', '.gatewright/prompt.md', '.gatewright/.worktrees',
  // policy: auto_dispatch_children, max_children_per_item, max_depth,
  // triage_required_for
  'n', '2', '2', 'agent',
  // guard: enabled, mode, accept, exempt_paths
  'y', '1', 'message,branch,owner', '.gatewright/',
  // id_scheme
  '1',
  // brief.max_lines
  '25',
  // check: stale_days, stale_exempt_stages
  '7', 'merged',
  // memory: enabled, provider, project_id, recall.on_dispatch, recall.top_k,
  // recall.max_chars, remember.on_run_ok, remember.on_close,
  // remember.max_chars, remember.extra_tags
  'n', 'second-brain', 'proj-one', 'y', '5', '2000', 'y', 'y', '800', 'gw',
  // github: enabled, repo, sync_interval_min, dispatch_label,
  // mirror_children, comment_on_move, close_on, milestone_to
  'y', 'org/repo', '15', 'agent/go', 'n', 'y', 'verified', 'phase',
  // vocab: phase, priority, type
  'P0,P1,P2', 'P0,P1', 'feature,defect,doc',
];

test('a scripted gw config set keeps gw check clean', async () => {
  const { root, store } = board();
  store.rebaselineDigest();
  const code = await config(ctxFor({ store, positionals: ['runner.max_concurrent', '3'] }));
  assert.equal(code, 0);
  checkClean(root);
});

test('a glossary write keeps gw check clean', async () => {
  const { root, store } = board();
  store.rebaselineDigest();
  const code = await config(ctxFor({ store, positionals: ['glossary.phase.P1', 'The first working version.'] }));
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(store.paths.config, 'utf8')).glossary.phase.P1, 'The first working version.');
  checkClean(root);
});

test('the interactive editor keeps gw check clean', async () => {
  const { root, store } = board();
  store.rebaselineDigest();
  // Same answer script as the editor test below: one answer per setting, in
  // declaration order. If SETTINGS changes, that test breaks first.
  const { input, output } = tty(EDITOR_ANSWERS);
  const code = await config(ctxFor({ store, stdin: input, stdout: output, env: {} }));
  assert.equal(code, 0);
  checkClean(root);
});

test('a non-interactive gw config lists settings instead of waiting for a human', async () => {
  const { store } = board();
  const stdout = capture();
  // No stdin at all, which is what a CI runner or an agent shell looks like.
  const code = await config(ctxFor({ store, stdout, stdin: new PassThrough() }));
  assert.equal(code, 0);
  assert.match(stdout.read(), /runner\.enabled\s+\(unset\)/);
  assert.match(stdout.read(), /runner\.max_concurrent\s+1/);
  assert.doesNotMatch(stdout.read(), /\x1b\[/, 'a non-TTY never receives terminal escapes');
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
  // One answer per setting, in declaration order; see EDITOR_ANSWERS above.
  // A short script here does not fail loudly, it stalls until the suite's
  // timeout, so this must stay in step with SETTINGS.
  const { input, output, read, remaining } = tty(EDITOR_ANSWERS);
  const code = await config(ctxFor({ store, stdin: input, stdout: output, env: {} }));
  assert.equal(code, 0);
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.equal(saved.runner.enabled, true);
  assert.equal(saved.runner.max_concurrent, 3);
  assert.equal(saved.runner.prompt_template, '.gatewright/prompt.md');
  assert.equal(saved.policy.max_children_per_item, 2);
  assert.equal(saved.guard.enabled, true);
  assert.equal(saved.guard.mode, 'block');
  assert.deepEqual(saved.guard.accept, ['message', 'branch', 'owner']);
  assert.equal(saved.brief.max_lines, 25);
  assert.equal(saved.check.stale_days, 7);
  assert.deepEqual(saved.vocab.phase, ['P0', 'P1', 'P2']);
  assert.deepEqual(saved.vocab.type, ['feature', 'defect', 'doc']);
  assert.equal(saved.memory.recall.top_k, 5);
  assert.equal(saved.github.sync_interval_min, 15, 'the key that decides whether the board ever syncs is settable here');
  assert.equal(saved.github.repo, 'org/repo');
  assert.equal(remaining(), 0, 'every setting was asked about exactly once');
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

async function keys(tty, ...sequence) {
  for (const key of sequence) {
    await new Promise((resolve) => setImmediate(resolve));
    tty.input.write(key);
  }
}

test('the rich settings screen shows sections, values and the danger note, and Esc cancels without writing', async () => {
  const { store } = board();
  const before = readFileSync(store.paths.config, 'utf8');
  const tty = rawTty();
  const run = config(ctxFor({ store, stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color' } }));
  // Nine runner settings and four policy settings precede guard.enabled.
  await keys(tty, ...Array(13).fill('\x1b[B'), '\x1b');
  assert.equal(await run, 1);
  assert.match(tty.read(), /COMMIT GUARD/);
  assert.match(tty.read(), /runner\.max_concurrent\s+1/);
  assert.match(tty.read(), /Warning: This is the only check that a commit is accounted for on the board/);
  assert.match(tty.read(), /Cancelled; nothing was changed/);
  assert.deepEqual(tty.raw, [true, false], 'raw mode is restored after cancelling the settings screen');
  assert.equal(readFileSync(store.paths.config, 'utf8'), before);
});

test('the rich settings screen edits a value, reviews it, and saves through the one write path', async () => {
  const { root, store } = board();
  store.rebaselineDigest();
  const tty = rawTty();
  const run = config(ctxFor({ store, stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color', NO_COLOR: '1' } }));
  // runner.max_concurrent is the third row: open it, replace 1 with 3.
  await keys(tty, 'j', 'j', '\r', '\x15', '9', '9', '\r');
  await keys(tty, '\x15', '3', '\r');
  // runner.enabled (first row) is a boolean: pick On.
  await keys(tty, 'g', '\r', '\x1b[A', '\r');
  await keys(tty, 's', '\r');
  assert.equal(await run, 0);
  assert.match(tty.read(), /runner\.max_concurrent must be at most 64/, 'an out-of-range value is refused on the screen');
  assert.match(tty.read(), /Save 2 changes/);
  assert.match(tty.read(), /runner\.max_concurrent: 1 → 3/);
  assert.match(tty.read(), /Saved to \.gatewright\/config\.json/);
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.equal(saved.runner.max_concurrent, 3);
  assert.equal(saved.runner.enabled, true);
  checkClean(root);
});

test('quitting the settings screen with unsaved edits asks before discarding them', async () => {
  const { store } = board();
  const before = readFileSync(store.paths.config, 'utf8');
  const tty = rawTty();
  const run = config(ctxFor({ store, stdin: tty.input, stdout: tty.output, env: { TERM: 'xterm-256color' } }));
  await keys(tty, 'j', 'j', '\r', '\x15', '5', '\r', 'q', 'y');
  assert.equal(await run, 0);
  assert.match(tty.read(), /Discard 1 unsaved change\?/);
  assert.match(tty.read(), /Discarded; nothing was changed/);
  assert.equal(readFileSync(store.paths.config, 'utf8'), before);
});

// T-0043 — `gw config vocab.type` prints `["decision","defect",...]`, and
// pasting that exact form back used to be comma-split without validation,
// storing strings with embedded quotes; `gw add --type doc` then refused
// `doc` while listing it as allowed. The bracketed form the command prints
// must be accepted back, validated, and the vocabulary must actually work
// afterwards — asserted through the real binary, end to end.
test('T-0043: the bracketed form config prints is accepted back and the vocabulary works', () => {
  const { root, store } = board({ vocab: { type: ['feature'] } });
  const printed = JSON.stringify(['decision', 'defect', 'feature', 'test', 'doc', 'spike']);
  const out = execFileSync(process.execPath, [BIN, 'config', 'vocab.type', '--yes', printed], { cwd: root, encoding: 'utf8' });
  assert.match(out, /vocab\.type = /);
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.deepEqual(saved.vocab.type, ['decision', 'defect', 'feature', 'test', 'doc', 'spike']);
  const id = execFileSync(process.execPath, [BIN, 'add', 'typed work', '--phase', 'P1', '--type', 'doc'], { cwd: root, encoding: 'utf8' }).trim();
  assert.match(id, /^[A-Z0-9.-]+$/, `gw add --type doc must succeed against the new vocabulary, got '${id}'`);
});

test('T-0043: the comma-separated form keeps working alongside the bracketed one', () => {
  const { root, store } = board();
  execFileSync(process.execPath, [BIN, 'config', 'vocab.priority', '--yes', 'P0,P1,P2'], { cwd: root, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')).vocab.priority, ['P0', 'P1', 'P2']);
});

test('T-0043: a bracketed value that is not a JSON array of strings is refused with the syntax named', () => {
  const { root, store } = board();
  const before = readFileSync(store.paths.config, 'utf8');
  for (const bad of ['["a", "b"', '[1,2]', '["a", 2]', '[', '{"a":1}', '["a","a"]', '[]', '["", "b"]']) {
    assert.throws(
      () => execFileSync(process.execPath, [BIN, 'config', 'vocab.type', '--yes', bad], { cwd: root, encoding: 'utf8' }),
      (error) => error.status === 2 && /JSON array|twice/.test(`${error.stderr}`),
      `the bracketed value ${bad} must be refused, not stored`,
    );
  }
  assert.equal(readFileSync(store.paths.config, 'utf8'), before, 'a refused value writes nothing');
});

test('T-0095.1: only list settings with a useful empty meaning accept []', () => {
  const { root, store } = board({
    policy: { triage_required_for: ['agent'] },
    guard: { exempt_paths: ['.gatewright/'], accept: ['message'] },
    check: { stale_exempt_stages: ['merged'] },
    memory: { remember: { extra_tags: ['gw'] } },
    vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'] },
  });
  for (const key of ['policy.triage_required_for', 'guard.exempt_paths', 'check.stale_exempt_stages', 'memory.remember.extra_tags']) {
    execFileSync(process.execPath, [BIN, 'config', key, 'none'], { cwd: root, encoding: 'utf8' });
  }
  const savedAfterNone = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.deepEqual(savedAfterNone.policy.triage_required_for, []);
  assert.deepEqual(savedAfterNone.guard.exempt_paths, []);
  assert.deepEqual(savedAfterNone.check.stale_exempt_stages, []);
  assert.deepEqual(savedAfterNone.memory.remember.extra_tags, []);
  for (const key of ['policy.triage_required_for', 'guard.exempt_paths', 'check.stale_exempt_stages', 'memory.remember.extra_tags']) {
    execFileSync(process.execPath, [BIN, 'config', key, '[]'], { cwd: root, encoding: 'utf8' });
  }
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.deepEqual(saved.policy.triage_required_for, []);
  assert.deepEqual(saved.guard.exempt_paths, []);
  assert.deepEqual(saved.check.stale_exempt_stages, []);
  assert.deepEqual(saved.memory.remember.extra_tags, []);
  for (const key of ['guard.accept', 'vocab.phase', 'vocab.priority', 'vocab.type']) {
    assert.throws(() => execFileSync(process.execPath, [BIN, 'config', key, '[]'], { cwd: root, encoding: 'utf8' }), /JSON array of non-empty strings/);
  }
});

test("T-0095.1: literal single-quoted [] is refused rather than stored as a list entry", () => {
  const { root, store } = board({ policy: { triage_required_for: ['agent'] } });
  const before = readFileSync(store.paths.config, 'utf8');
  assert.throws(
    () => execFileSync(process.execPath, [BIN, 'config', 'policy.triage_required_for', "'[]'"], { cwd: root, encoding: 'utf8' }),
    (error) => error.status === 2 && /quoted \[\] is not valid.*use none or \[\] for an empty list/i.test(`${error.stderr}`),
  );
  assert.equal(readFileSync(store.paths.config, 'utf8'), before, 'a quoted empty-array spelling writes nothing');
});
