import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { guardCommit, findItemId } from '../lib/guard.js';
import { run } from '../lib/commands/guard.js';

const stages = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'verified' }], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped' }] };
const item = (over = {}) => ({ id: 'P1-01', title: 'a', stage: 'building', owner: null, deps: [], evidence: [], updated: new Date().toISOString(), ...over });

function board(items = [item()], config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-guard-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify(config));
  return { root, store };
}

// The git boundary is injected, so no test here needs a checkout: the command
// is exercised on exactly the argv-shaped answers git would have given.
function fakeGit(answers = {}) {
  return {
    run(argv) {
      const key = argv.join(' ');
      for (const [prefix, value] of Object.entries(answers)) {
        if (key.startsWith(prefix)) return { stdout: value, status: 0 };
      }
      throw new Error(`unexpected git ${key}`);
    },
  };
}

function ctx(b, flags = {}, actor = 'human:test') {
  let out = ''; let err = '';
  return {
    out: () => out,
    err: () => err,
    ctx: { flags, positionals: [], store: b.store, root: b.root, actor, env: {}, stdout: { write(s) { out += s; } }, stderr: { write(s) { err += s; } } },
  };
}

test('an id is recognised in a branch name but never inside a longer id', () => {
  const ids = ['P1-01', 'P1-01.2'];
  assert.equal(findItemId('feat/P1-01-human-board', ids), 'P1-01');
  assert.equal(findItemId('P1-01.2: subject', ids), 'P1-01.2', 'the longer id wins over its own parent');
  assert.equal(findItemId('P1-011: subject', ids), null, 'a longer number is a different item, not this one');
  assert.equal(findItemId('fixes p1-01', ids), 'P1-01', 'branch names are routinely lowercased');
});

test('a claimed item accounts for a commit that names nothing', () => {
  const verdict = guardCommit({ message: 'fix the parser', files: ['lib/a.js'], items: [item({ owner: 'human:test' })], actor: 'human:test', stages });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, 'owner');
  assert.equal(verdict.id, 'P1-01');
});

test('a commit with no claim, no id in the message and no id in the branch is refused with fixes', () => {
  const verdict = guardCommit({ message: 'quick fix', branch: 'main', files: ['lib/a.js'], items: [item()], actor: 'human:test', stages });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /no item is claimed by human:test/);
  assert.ok(verdict.fixes.some((fix) => fix.startsWith('gw add')));
});

test('naming an item that is not on the board is refused as its own mistake', () => {
  const verdict = guardCommit({ message: 'P9-99: done', files: ['lib/a.js'], items: [item()], stages });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /P9-99 is not an item on this board/);
});

// Found by pointing guard at this project's own board: 127 items sitting in a
// `role: "done"` stage, every one of them still claimed, and every one of them
// happy to vouch for any commit their owner made months later.
test('an item in a role:"done" stage is finished even when the stage is not listed as terminal', () => {
  const trunk = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }], terminal: ['dropped'], extra: [{ id: 'dropped' }] };
  const done = item({ stage: 'built', owner: 'human:test' });
  assert.equal(guardCommit({ message: 'later, unrelated', files: ['lib/a.js'], items: [done], actor: 'human:test', stages: trunk }).ok, false);
  assert.match(guardCommit({ message: 'P1-01: one more', files: ['lib/a.js'], items: [done], stages: trunk }).reason, /already built/);
});

test('an item that is already finished cannot account for new work', () => {
  const verdict = guardCommit({ message: 'P1-01: one more thing', files: ['lib/a.js'], items: [item({ stage: 'verified' })], stages });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /already verified/);
});

test('a commit that only writes the board needs no item of its own', () => {
  const verdict = guardCommit({ message: 'board', files: ['.gatewright/items.jsonl', '.gatewright/.digest'], items: [item()], stages });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, 'exempt');
});

test('a board commit that also changes code is judged on the code', () => {
  const verdict = guardCommit({ message: 'board', files: ['.gatewright/items.jsonl', 'lib/a.js'], items: [item()], stages });
  assert.equal(verdict.ok, false);
});

test('accept can be narrowed so a bare claim no longer excuses a commit', () => {
  const config = { guard: { accept: ['message'] } };
  const verdict = guardCommit({ message: 'fix', branch: 'gw/P1-01', files: ['lib/a.js'], items: [item({ owner: 'human:test' })], actor: 'human:test', stages, config });
  assert.equal(verdict.ok, false);
});

test('guard reads the staged files and branch from git and exits 1 on a refusal', () => {
  const b = board();
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });
  const result = ctx(b, { message: 'just a tweak' });
  assert.equal(run(result.ctx, { git }), 1);
  assert.match(result.err(), /not on the board/);
  assert.match(result.err(), /--no-verify/);
});

test('guard judges the message file, and ignores the comment block git will strip', () => {
  const b = board();
  const messageFile = join(b.root, 'COMMIT_EDITMSG');
  writeFileSync(messageFile, 'a tweak\n\n# On branch gw/P1-01\n# Changes to be committed:\n');
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });
  const result = ctx(b, { 'message-file': messageFile });
  assert.equal(run(result.ctx, { git }), 1, 'the id in the stripped comment must not count as a reference');
});

test('warn mode reports the same refusal and still lets the commit through', () => {
  const b = board([item()], { guard: { mode: 'warn' } });
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });
  const result = ctx(b, { message: 'tweak' });
  assert.equal(run(result.ctx, { git }), 0);
  assert.match(result.err(), /warning/);
  assert.doesNotMatch(result.err(), /--no-verify/, 'nothing is being bypassed, so nothing suggests bypassing it');
});

test('a disabled guard says nothing and refuses nothing', () => {
  const b = board([item()], { guard: { enabled: false } });
  const result = ctx(b, { message: 'tweak' });
  assert.equal(run(result.ctx, { git: fakeGit() }), 0);
  assert.equal(result.err(), '');
});

test('a passing guard is silent, because a hook that chatters gets uninstalled', () => {
  const b = board([item({ owner: 'human:test' })]);
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });
  const result = ctx(b, { message: 'tweak' });
  assert.equal(run(result.ctx, { git }), 0);
  assert.equal(result.out() + result.err(), '');
});

test('--range judges every commit in the range on its own message, not on who claimed what', () => {
  const b = board([item({ owner: 'human:test' })]);
  const git = fakeGit({
    'rev-list': 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n',
    'log -1 --format=%B aaaaaaaaaaaa': 'P1-01: the tracked one\n',
    'log -1 --format=%B bbbbbbbbbbbb': 'drive-by fix\n',
    'show --name-only --format= aaaaaaaaaaaa': 'lib/a.js\n',
    'show --name-only --format= bbbbbbbbbbbb': 'lib/b.js\n',
  });
  const result = ctx(b, { range: 'main..HEAD', branch: 'feature', json: true });
  assert.equal(run(result.ctx, { git }), 1);
  const { results } = JSON.parse(result.out());
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false, 'the claim held locally must not vouch for a commit in CI');
});

// --pretool is the gate that runs before the edit, not after the fact. It
// speaks the provider hook contract: a decision on stdout, exit 0 either way.
test('--pretool refuses an edit that no item accounts for, and says how to fix it', () => {
  const b = board();
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  const result = ctx(b, { pretool: true, file: 'lib/a.js' });
  assert.equal(run(result.ctx, { git, readStdin: () => '' }), 0, 'a refused edit is not a broken hook');
  const decision = JSON.parse(result.out()).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /gw add/);
  assert.match(decision.permissionDecisionReason, /gw claim/);
});

test('--pretool allows the edit once the work is on the board and claimed', () => {
  const b = board([item({ owner: 'human:test' })]);
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  const result = ctx(b, { pretool: true, file: 'lib/a.js' });
  assert.equal(run(result.ctx, { git, readStdin: () => '' }), 0);
  assert.equal(result.out(), '', 'an allowed edit needs no decision at all');
});

test('--pretool reads the provider tool call from stdin', () => {
  const b = board([item({ owner: 'human:test' })]);
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  const call = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(b.root, 'lib', 'a.js') } });
  const result = ctx(b, { pretool: true });
  assert.equal(run(result.ctx, { git, readStdin: () => call }), 0);
  assert.equal(result.out(), '');
});

test('--pretool never gates the board itself, or a file outside the repository', () => {
  const b = board();
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  for (const file of ['.gatewright/items.jsonl', '/etc/hosts']) {
    const result = ctx(b, { pretool: true, file });
    assert.equal(run(result.ctx, { git, readStdin: () => '' }), 0);
    assert.equal(result.out(), '', `${file} must not be gated`);
  }
});

test('warn mode lets the edit through rather than denying it', () => {
  const b = board([item()], { guard: { mode: 'warn' } });
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  const result = ctx(b, { pretool: true, file: 'lib/a.js' });
  assert.equal(run(result.ctx, { git, readStdin: () => '' }), 0);
  assert.equal(result.out(), '');
});
