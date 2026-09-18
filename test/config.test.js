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

function ctxFor({ store, positionals = [], flags = {}, env = {}, stdin, stdout = capture() }) {
  return { store, positionals, flags, env, stdin, stdout };
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
