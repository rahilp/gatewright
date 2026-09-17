import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/hook.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const stages = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'verified' }], terminal: ['verified'], extra: [] };

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gw-hook-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  const store = createStore(root);
  store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify({}));
  return { root, store };
}

function ctx(r, flags = {}, positionals = []) {
  let out = '';
  return { out: () => out, ctx: { flags, positionals, store: r.store, root: r.root, actor: 'human:test', env: {}, stdout: { write(s) { out += s; } }, stderr: { write(s) { out += s; } } } };
}

const hookPath = (root) => join(root, '.git', 'hooks', 'commit-msg');

test('install writes an executable commit-msg hook and status reports it', () => {
  const r = repo();
  const install = ctx(r, {}, ['install']);
  assert.equal(run(install.ctx), 0);
  assert.equal(existsSync(hookPath(r.root)), true);
  assert.match(readFileSync(hookPath(r.root), 'utf8'), /gw guard --message-file/);
  const status = ctx(r, {}, ['status']);
  assert.equal(run(status.ctx), 0);
  assert.match(status.out(), /commit-msg hook: installed/);
  assert.doesNotMatch(status.out(), /not executable/);
});

test('installing twice replaces the block rather than stacking copies of it', () => {
  const r = repo();
  run(ctx(r, {}, ['install']).ctx);
  run(ctx(r, {}, ['install']).ctx);
  const text = readFileSync(hookPath(r.root), 'utf8');
  assert.equal(text.match(/gatewright:start/g).length, 1);
});

test('an existing hook keeps working: the block is appended, and removed again on uninstall', () => {
  const r = repo();
  mkdirSync(join(r.root, '.git', 'hooks'), { recursive: true });
  const theirs = '#!/bin/sh\necho "someone else was here"\n';
  writeFileSync(hookPath(r.root), theirs);
  run(ctx(r, {}, ['install']).ctx);
  assert.match(readFileSync(hookPath(r.root), 'utf8'), /someone else was here/);

  const uninstall = ctx(r, {}, ['uninstall']);
  assert.equal(run(uninstall.ctx), 0);
  const after = readFileSync(hookPath(r.root), 'utf8');
  assert.match(after, /someone else was here/);
  assert.doesNotMatch(after, /gatewright/);
});

test('uninstall removes a hook file gatewright created outright', () => {
  const r = repo();
  run(ctx(r, {}, ['install']).ctx);
  run(ctx(r, {}, ['uninstall']).ctx);
  assert.equal(existsSync(hookPath(r.root)), false);
});

test('uninstalling what was never installed is not an error', () => {
  const r = repo();
  const result = ctx(r, {}, ['uninstall']);
  assert.equal(run(result.ctx), 0);
  assert.match(result.out(), /no gatewright commit-msg hook/);
});

test('--ci installs a workflow that runs both check and guard, pinned to this version', () => {
  const r = repo();
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
  run(ctx(r, { ci: true }, ['install']).ctx);
  const workflow = readFileSync(join(r.root, '.github', 'workflows', 'gatewright.yml'), 'utf8');
  assert.match(workflow, new RegExp(`gatewright@${version.replace(/\./g, '\\.')} check`));
  assert.match(workflow, /guard --range/);
  assert.doesNotMatch(workflow, /__VERSION__/);
});

test('an unknown action is a usage error, not a silent no-op', () => {
  const r = repo();
  assert.throws(() => run(ctx(r, {}, ['enable']).ctx), /unknown hook action 'enable'/);
});

// The one test that proves the whole chain: git really invokes the hook, the
// hook really finds the CLI, and the CLI really stops the commit.
test('git refuses an untracked commit and accepts one that names an item', (t) => {
  const probe = spawnSync('git', ['--version']);
  if (probe.error) { t.skip('git is unavailable'); return; }
  const r = repo();
  r.store.writeItems([{ id: 'P1-01', title: 'a', stage: 'building', owner: null, deps: [], evidence: [], updated: new Date().toISOString() }]);
  run(ctx(r, {}, ['install']).ctx);

  // The hook looks gw up on PATH, the way it will in a real checkout.
  const shim = mkdtempSync(join(tmpdir(), 'gw-bin-'));
  writeFileSync(join(shim, 'gw'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(shim, 'gw'), 0o755);
  const env = { ...process.env, PATH: `${shim}:${process.env.PATH}`, GW_ACTOR: 'human:test' };

  writeFileSync(join(r.root, 'code.js'), 'export const a = 1;\n');
  execFileSync('git', ['add', 'code.js'], { cwd: r.root });

  const refused = spawnSync('git', ['commit', '-m', 'drive-by change'], { cwd: r.root, env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0, 'an untracked commit must not land');
  assert.match(refused.stderr, /not on the board/);

  const accepted = spawnSync('git', ['commit', '-m', 'P1-01: the tracked change'], { cwd: r.root, env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);

  // --no-verify stays a door, on purpose; it just leaves fingerprints in the log.
  writeFileSync(join(r.root, 'code.js'), 'export const a = 2;\n');
  execFileSync('git', ['add', 'code.js'], { cwd: r.root });
  const bypassed = spawnSync('git', ['commit', '--no-verify', '-m', 'urgent'], { cwd: r.root, env, encoding: 'utf8' });
  assert.equal(bypassed.status, 0, bypassed.stderr);
});

test('--agent adds the pre-edit guard to project settings without disturbing what is already there', () => {
  const r = repo();
  const settingsPath = join(r.root, '.claude', 'settings.json');
  mkdirSync(join(r.root, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({
    permissions: { allow: ['Bash(npm test:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-own-check' }] }] },
  }, null, 2));

  run(ctx(r, { agent: true }, ['install']).ctx);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(after.permissions.allow, ['Bash(npm test:*)']);
  assert.equal(after.hooks.PreToolUse.length, 2);
  assert.equal(after.hooks.PreToolUse[0].hooks[0].command, 'their-own-check');
  assert.match(after.hooks.PreToolUse[1].hooks[0].command, /gw guard --pretool/);

  run(ctx(r, { agent: true }, ['install']).ctx);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.PreToolUse.length, 2, 'installing twice must not stack');

  run(ctx(r, { agent: true }, ['uninstall']).ctx);
  const removed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(removed.hooks.PreToolUse.length, 1);
  assert.equal(removed.hooks.PreToolUse[0].hooks[0].command, 'their-own-check');
  assert.deepEqual(removed.permissions.allow, ['Bash(npm test:*)']);
});

test('status reports all three gates', () => {
  const r = repo();
  const before = ctx(r, {}, ['status']);
  run(before.ctx);
  assert.match(before.out(), /commit-msg hook: not installed/);
  assert.match(before.out(), /CI check: not installed/);
  assert.match(before.out(), /agent pre-edit guard: not installed/);

  run(ctx(r, { ci: true, agent: true }, ['install']).ctx);
  const after = ctx(r, {}, ['status']);
  run(after.ctx);
  assert.doesNotMatch(after.out(), /not installed/);
});

test('malformed project settings are a fixable error, not a clobbered file', () => {
  const r = repo();
  mkdirSync(join(r.root, '.claude'), { recursive: true });
  writeFileSync(join(r.root, '.claude', 'settings.json'), '{ not json');
  assert.throws(() => run(ctx(r, { agent: true }, ['install']).ctx), /not valid JSON/);
  assert.equal(readFileSync(join(r.root, '.claude', 'settings.json'), 'utf8'), '{ not json');
});

// The hook has to survive the CLI it calls being absent or out of date: an
// installed gatewright is not a promise about what is on PATH a year later.
test('the hook steps aside rather than blocking commits when gw cannot answer', (t) => {
  const probe = spawnSync('sh', ['-c', 'true']);
  if (probe.error) { t.skip('no POSIX shell'); return; }
  const r = repo();
  run(ctx(r, {}, ['install']).ctx);
  const empty = mkdtempSync(join(tmpdir(), 'gw-nopath-'));

  for (const [label, path] of [['gw is absent', empty], ['gw is too old to know guard', (() => {
    const old = mkdtempSync(join(tmpdir(), 'gw-old-'));
    writeFileSync(join(old, 'gw'), '#!/bin/sh\necho "gw: unknown command \'guard\'" >&2\nexit 2\n');
    chmodSync(join(old, 'gw'), 0o755);
    return old;
  })()]]) {
    const result = spawnSync('/bin/sh', [hookPath(r.root), join(r.root, 'MSG')], { env: { PATH: path }, encoding: 'utf8' });
    assert.equal(result.error, undefined, `${label}: the hook could not be run at all`);
    assert.equal(result.status, 0, `${label}: the hook must not refuse the commit (${result.stderr})`);
  }
});
