import './helpers/isolate-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { guardCommit, findItemId } from '../lib/guard.js';
import { run } from '../lib/commands/guard.js';
import { run as claim } from '../lib/commands/claim.js';

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

// T-0041 — `gw claim <id> --by rahil` stores the bare name the human typed;
// the default actor is "human:rahil". An exact-string comparison refused the
// very person who claimed the item, and guard's own suggested fix
// (`gw claim <id>`) dead-ended on "already owned". A bare name and its
// qualified form are the same owner; two explicit qualifiers must still
// agree, because provenance is the point of the prefix.
test('an owner stored bare by --by is the same owner as the qualified actor', () => {
  const verdict = guardCommit({ message: 'unrelated', files: ['lib/a.js'], items: [item({ owner: 'test' })], actor: 'human:test', stages });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, 'owner');

  assert.equal(guardCommit({ message: 'unrelated', files: ['lib/a.js'], items: [item({ owner: 'human:test' })], actor: 'test', stages }).ok, true);
  assert.equal(guardCommit({ message: 'unrelated', files: ['lib/a.js'], items: [item({ owner: 'agent:test' })], actor: 'human:test', stages }).ok, false, 'same name, different kind: provenance still matters');
});

test('guard\'s suggested claim clears the refusal when the owner stored a bare name', () => {
  const b = board([item({ owner: 'test' })]);
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });

  assert.doesNotThrow(() => claim({ store: b.store, flags: {}, actor: 'human:test', positionals: ['P1-01'] }), 'the suggested `gw claim <id>` must not dead-end on "already owned"');
  const after = ctx(b, { message: 'tweak' });
  assert.equal(run(after.ctx, { git }), 0, 'the owner stored by `--by <name>` vouches for the qualified actor');
});

// T-0042 — the example was "P1-07: <subject>", a phase-seq id that guard
// itself refuses on the default `seq` board. The example must name an id the
// board would accept: a real one when the board has items, else one minted
// from the board's id scheme.
test('the refusal example names an id this board would accept', () => {
  const exampleOf = (verdict) => verdict.fixes.find((fix) => fix.includes('e.g.'));
  const verdict = guardCommit({ message: 'quick fix', branch: 'main', files: ['lib/a.js'], items: [item()], actor: 'human:test', stages });
  assert.match(exampleOf(verdict), /"P1-01: <subject>"/);

  // And the example is real: a commit named exactly that way passes.
  assert.equal(guardCommit({ message: 'P1-01: the work', files: ['lib/a.js'], items: [item()], stages }).ok, true);

  const emptySeq = guardCommit({ message: 'x', files: ['lib/a.js'], items: [], actor: 'human:test', stages, config: { id_scheme: 'seq' } });
  assert.match(exampleOf(emptySeq), /"T-0001: <subject>"/);

  const emptyPhaseSeq = guardCommit({ message: 'x', files: ['lib/a.js'], items: [], actor: 'human:test', stages, config: { id_scheme: 'phase-seq', vocab: { phase: ['P2'] } } });
  assert.match(exampleOf(emptyPhaseSeq), /"P2-01: <subject>"/);
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

// T-0028 — found by pointing guard at this project's own board: a rollup
// commit of 21 already-built items was refused, and `--no-verify` — the off
// switch for the whole check — was the only escape. A check whose only
// escape hatch is to turn it off gets turned off habitually, and then it
// protects nothing. So the question is "is this change accounted for on the
// board", and an item that is built IS accounted for.
test('an item in a role:"done" stage is finished even when the stage is not listed as terminal', () => {
  const trunk = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }], terminal: ['dropped'], extra: [{ id: 'dropped' }] };
  const done = item({ stage: 'built', owner: 'human:test' });
  assert.equal(guardCommit({ message: 'later, unrelated', files: ['lib/a.js'], items: [done], actor: 'human:test', stages: trunk }).ok, false, 'a finished claim does not vouch for unnamed new work');
  const verdict = guardCommit({ message: 'P1-01: one more', files: ['lib/a.js'], items: [done], stages: trunk });
  assert.equal(verdict.ok, true, 'a named finished item still accounts for the change');
  assert.deepEqual(verdict.warnings, ['P1-01 is already built']);
});

test('a commit naming an already finished item passes with a warning naming the item and its stage', () => {
  const verdict = guardCommit({ message: 'P1-01: one more thing', files: ['lib/a.js'], items: [item({ stage: 'verified' })], stages });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, ['P1-01 is already verified']);
});

test('a rollup naming several finished items warns once per finished one, deduped across message and branch', () => {
  const verdict = guardCommit({
    message: 'land P1-01, P1-02 and P1-03',
    branch: 'rollup/P1-02',
    files: ['lib/a.js'],
    items: [item({ id: 'P1-01', stage: 'verified' }), item({ id: 'P1-02', stage: 'verified' }), item({ id: 'P1-03', stage: 'building' })],
    stages,
  });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.warnings, ['P1-01 is already verified', 'P1-02 is already verified'], 'P1-02 is named twice and warned once; the in-flight one warns not at all');
});

// The regression that reversed the first version of this rule: a security
// fix citing a CVE is an ordinary commit, and refusing it for a token guard
// cannot distinguish from prose pushed people to --no-verify for ordinary
// work -- the exact disease T-0028 was filed to prevent.
test('a commit naming a real item alongside a CVE-style token passes, quietly', () => {
  const verdict = guardCommit({ message: 'T-0001: patch for CVE-2024-5678', files: ['lib/a.js'], items: [item({ owner: 'human:test' })], actor: 'human:test', stages });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.warnings, undefined, 'an unmatched token is not worth a warning — most commits that mention a CVE would trip it, and a constant warning trains people to ignore guard');

  assert.equal(guardCommit({ message: 'P1-01: handle HTTP-404 better', files: ['lib/a.js'], items: [item()], stages }).ok, true);
  assert.equal(guardCommit({ message: 'P1-01: land T-0099 too', files: ['lib/a.js'], items: [item()], stages }).ok, true, 'an invented id rides along the same as prose: guard cannot tell them apart');
});

test('an unmatched token does not refuse when the actor claims an item', () => {
  const verdict = guardCommit({ message: 'ugh, HTTP-404 handler', files: ['lib/a.js'], items: [item({ owner: 'human:test' })], actor: 'human:test', stages });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.via, 'owner');
});

test('a commit naming only tokens that match nothing is refused, listing what it tried', () => {
  const verdict = guardCommit({ message: 'CVE-2024-5678 and T-0099', files: ['lib/a.js'], items: [item()], stages });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /CVE-2024, T-0099 are not items on this board/);

  const claimed = guardCommit({ message: 'CVE-2024-5678', files: ['lib/a.js'], items: [item({ owner: 'human:other' })], actor: 'human:test', stages });
  assert.equal(claimed.ok, false);
  assert.match(claimed.reason, /no item is claimed by human:test, and the only id named, CVE-2024, is not an item on this board/);
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

// T-0028 — at the command boundary the pass-with-warning must be visible on
// stderr and must not flip the exit code, or the warning would train readers
// to ignore guard's output entirely.
test('a commit naming a built item exits 0 with a one-line warning', () => {
  const trunk = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }], terminal: ['dropped'], extra: [{ id: 'dropped' }] };
  const root = mkdtempSync(join(tmpdir(), 'gw-guard-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems([item({ stage: 'built' })]);
  writeFileSync(store.paths.stages, JSON.stringify(trunk));
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n', 'diff --cached --name-only': 'lib/a.js\n' });
  const result = ctx({ root, store }, { message: 'P1-01: the landed work' });
  assert.equal(run(result.ctx, { git }), 0);
  assert.match(result.err(), /^gw: warning: P1-01 is already built\n$/);
  assert.doesNotMatch(result.err(), /--no-verify/);
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

// A pull request is reviewed after its work is done. Refusing it because the
// item it names reached the finish line would fail every completed branch.
test('--range accepts a commit naming an item that has since been finished', () => {
  const b = board([item({ id: 'P1-01', stage: 'verified' })]);
  const git = fakeGit({
    'rev-list': 'aaaaaaaaaaaa\n',
    'log -1 --format=%B aaaaaaaaaaaa': 'P1-01: the work\n',
    'show --name-only --format= aaaaaaaaaaaa': 'lib/a.js\n',
  });
  const result = ctx(b, { range: 'main..HEAD', branch: 'feature' });
  assert.equal(run(result.ctx, { git }), 0);

  // T-0028 — the same commit, made now rather than reviewed later, passes
  // too: the item is on the board and finished, which is the question. It
  // says so with a warning instead of refusing.
  assert.equal(guardCommit({ message: 'P1-01: the work', files: ['lib/a.js'], items: [item({ stage: 'verified' })], stages }).ok, true);
});

test('--range still refuses a commit naming an item that does not exist', () => {
  const b = board([item()]);
  const git = fakeGit({
    'rev-list': 'aaaaaaaaaaaa\n',
    'log -1 --format=%B aaaaaaaaaaaa': 'P9-99: invented\n',
    'show --name-only --format= aaaaaaaaaaaa': 'lib/a.js\n',
  });
  const result = ctx(b, { range: 'main..HEAD', branch: 'feature' });
  assert.equal(run(result.ctx, { git }), 1);
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
  assert.doesNotMatch(decision.permissionDecisionReason, /--phase/);
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

// The product consequence of the containment bug: the first tool call of any
// new task is usually a Write to a file that does not exist yet.
test('--pretool gates a file that does not exist yet, under a root reached by a symlink', () => {
  const b = board();
  const link = join(mkdtempSync(join(tmpdir(), 'gw-link-')), 'repo');
  symlinkSync(b.root, link);
  const git = fakeGit({ 'rev-parse --abbrev-ref HEAD': 'main\n' });
  const call = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: join(link, 'lib', 'brand-new.js') } });
  const result = ctx(b, { pretool: true });
  assert.equal(run(result.ctx, { git, readStdin: () => call }), 0);
  assert.match(result.out(), /permissionDecision":"deny/, 'a new file inside the repository must still be gated');
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
