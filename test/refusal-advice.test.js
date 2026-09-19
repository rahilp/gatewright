import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { runPrintedCommand } from './helpers/printed-command.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const ACTOR = { ...process.env, GW_ACTOR: 'human:advice-test' };

// This intentionally small pipeline makes each gate independently reachable.
// The fixture files are setup, not advice: every command under test is the real
// binary, and every remedy goes through the platform shell helper.
const stages = {
  stages: [
    { id: 'backlog' },
    { id: 'specified', requires: { scope: true } },
    { id: 'building', requires: { owner: true } },
    { id: 'built', requires: { evidence_min: 1 } },
    { id: 'review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+$' } },
    { id: 'done', requires: { evidence_min: 2, deps_at_least: 'built', children_done: true } },
  ],
  terminal: ['done', 'dropped'],
  extra: [{ id: 'paused' }, { id: 'dropped' }],
};

const item = (id = 'T-0001', over = {}) => ({
  id, title: id, stage: 'backlog', scope: '', owner: null, flag: null,
  deps: [], evidence: [], updated: new Date().toISOString(), ...over,
});

function board(items = [item()], config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-refusal-advice-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  writeFileSync(store.paths.config, JSON.stringify(config));
  store.rebaselineDigest();
  return { root, store };
}

function cli(root, args, env = ACTOR) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  return { ...result, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function printed(output) {
  return [...output.matchAll(/`(gw [^`]+)`/g)].map((match) => match[1]);
}

function runAdvice(root, output, substitutions = {}, { reverse = false } = {}) {
  const commands = printed(output);
  assert.ok(commands.length, `refusal printed no gw command:\n${output}`);
  for (const original of (reverse ? [...commands].reverse() : commands)) {
    const command = Object.entries(substitutions).reduce((text, [from, to]) => text.replaceAll(from, to), original);
    const result = runPrintedCommand(root, command, ACTOR);
    assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
    assert.equal(result.status, 0, `${command}\n${result.stdout}\n${result.stderr}`);
  }
  return commands;
}

function refusal(root, args, env = ACTOR) {
  const result = cli(root, args, env);
  assert.equal(result.error, undefined, `could not run gw ${args.join(' ')}: ${result.error?.message}`);
  assert.notEqual(result.status, 0, `expected gw ${args.join(' ')} to refuse`);
  return result.output;
}

function stageOf(store, id = 'T-0001') { return store.readItems().find((entry) => entry.id === id)?.stage; }

test('move gate advice is executable, including documented substitutions', () => {
  // <what done looks like> is deliberately replaced inside the CLI's existing
  // double quotes; that spelling is accepted by both /bin/sh and cmd.exe.
  {
    const b = board(); const out = refusal(b.root, ['move', 'T-0001', 'specified']);
    runAdvice(b.root, out, { '<what done looks like>': 'a scoped outcome' });
    assert.equal(cli(b.root, ['move', 'T-0001', 'specified']).status, 0);
  }
  {
    const b = board([item('T-0001', { stage: 'specified', scope: 'x' })]);
    const out = refusal(b.root, ['move', 'T-0001', 'building']);
    runAdvice(b.root, out);
    assert.equal(cli(b.root, ['move', 'T-0001', 'building']).status, 0);
  }
  {
    const b = board([item('T-0001', { stage: 'building', scope: 'x', owner: 'human:advice-test' })]);
    const out = refusal(b.root, ['move', 'T-0001', 'built']);
    runAdvice(b.root, out);
    assert.equal(stageOf(b.store), 'built');
  }
  {
    const b = board([item('T-0001', { stage: 'built', scope: 'x', owner: 'human:advice-test', evidence: [{ text: 'one', stage: 'built' }] })]);
    const out = refusal(b.root, ['move', 'T-0001', 'review']);
    runAdvice(b.root, out, { '<pull-request url>': 'https://github.com/acme/gatewright/pull/1' });
    assert.equal(stageOf(b.store), 'review');
  }
  {
    const dep = item('T-0002', { stage: 'building', scope: 'x', owner: 'human:advice-test' });
    const b = board([item('T-0001', { stage: 'review', scope: 'x', owner: 'human:advice-test', deps: ['T-0002'], evidence: [{ text: 'one', stage: 'built' }, { text: 'https://github.com/acme/gatewright/pull/1', stage: 'review' }] }), dep]);
    const out = refusal(b.root, ['move', 'T-0001', 'done']);
    // Dependency advice is executed verbatim. The dependency gate needs
    // evidence too, so this proves the printed command supplies it.
    runAdvice(b.root, out, {}, { reverse: true });
    assert.equal(stageOf(b.store, 'T-0002'), 'built');
    assert.equal(stageOf(b.store), 'done');
  }
  {
    const deps = ['T-0002', 'T-0003'].map((id) => item(id, {
      stage: 'building', scope: 'x', owner: 'human:advice-test',
    }));
    const b = board([item('T-0001', {
      stage: 'review', scope: 'x', owner: 'human:advice-test', deps: deps.map(({ id }) => id),
      evidence: [{ text: 'one', stage: 'built' }, { text: 'https://github.com/acme/gatewright/pull/1', stage: 'review' }],
    }), ...deps]);
    const out = refusal(b.root, ['move', 'T-0001', 'done']);
    const commands = runAdvice(b.root, out, {}, { reverse: true });
    assert.ok(commands.some((command) => command.startsWith('gw move T-0002 built --evidence ')), out);
    assert.ok(commands.some((command) => command.startsWith('gw move T-0003 built --evidence ')), out);
    assert.equal(stageOf(b.store, 'T-0002'), 'built');
    assert.equal(stageOf(b.store, 'T-0003'), 'built');
    assert.equal(stageOf(b.store), 'done');
  }
  {
    const b = board([item('T-0001', { scope: 'x' })]); const out = refusal(b.root, ['move', 'T-0001', 'built']);
    runAdvice(b.root, out);
    assert.equal(stageOf(b.store), 'specified', 'the first required pipeline condition is gone');
    assert.doesNotMatch(refusal(b.root, ['move', 'T-0001', 'built']), /backlog: move here first/);
  }
  {
    const b = board([item('T-0001', { stage: 'done', scope: 'x', evidence: [{ text: 'one', stage: 'built' }, { text: 'two', stage: 'done' }] })]);
    const out = refusal(b.root, ['move', 'T-0001', 'backlog']);
    runAdvice(b.root, out);
    assert.notEqual(stageOf(b.store), 'done', 'terminal-stage refusal is gone after its two printed commands');
  }
});

test('ownership and triage alternatives each work on their own board', () => {
  {
    const b = board([item('T-0001', { owner: 'human:other' })]);
    const out = refusal(b.root, ['claim', 'T-0001']); runAdvice(b.root, out);
    assert.equal(cli(b.root, ['claim', 'T-0001']).status, 0);
  }
  {
    const b = board([item('T-0001', { stage: 'specified', scope: 'x', owner: 'human:other' })]);
    const out = refusal(b.root, ['move', 'T-0001', 'building']); runAdvice(b.root, out);
    assert.equal(cli(b.root, ['move', 'T-0001', 'building']).status, 0);
  }
  {
    const b = board([item('T-0001', { owner: 'human:other' })]);
    const out = refusal(b.root, ['release', 'T-0001']); runAdvice(b.root, out);
    assert.equal(cli(b.root, ['release', 'T-0001']).status, 0);
  }
  // These are alternatives, so no state is shared between them.
  for (const alternative of ['approve', 'drop']) {
    const b = board([item('T-0001', { flag: 'needs-triage', created_by: 'agent:maker' })]);
    const out = refusal(b.root, ['move', 'T-0001', 'specified']);
    const command = printed(out).find((entry) => entry.endsWith(`--${alternative}`));
    assert.ok(command, out);
    const result = runPrintedCommand(b.root, command, ACTOR);
    assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    assert.notEqual(b.store.readItems().find((entry) => entry.id === 'T-0001')?.flag, 'needs-triage');
  }
});

test('check, next, edit, import, config, and repair remedies run through the printed shell', () => {
  // guard's pre-tool refusal is a JSON provider decision, not a terminal
  // sentence; it intentionally has no backtick-quoted gw command. Supplying
  // --branch keeps this case independent of git (and of any real checkout).
  {
    const b = board();
    const guarded = cli(b.root, ['guard', '--pretool', '--branch', 'advice-test', '--tool', 'Edit', '--file', 'src/new.js']);
    assert.equal(guarded.status, 0);
    const reason = JSON.parse(guarded.output).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /Nothing on the gatewright board accounts for this edit/);
    assert.equal(printed(reason).length, 0, 'provider advice is intentionally plain numbered prose');
  }
  {
    const b = board([item('T-0001', { flag: 'needs-triage', created_by: 'agent:maker' })]);
    const out = cli(b.root, ['check']).output;
    const command = printed(out).find((entry) => entry.endsWith('--approve'));
    assert.ok(command, out);
    assert.equal(runPrintedCommand(b.root, command, ACTOR).status, 0);
    assert.doesNotMatch(cli(b.root, ['check']).output, /INBOX|NEEDS TRIAGE/);
  }
  {
    const b = board([item('T-0001', { stage: 'specified', scope: 'x', deps: ['T-0002'] }), item('T-0002', { stage: 'dropped' })]);
    const out = cli(b.root, ['next', 'T-0001']).output; runAdvice(b.root, out);
    assert.deepEqual(b.store.readItems().find((entry) => entry.id === 'T-0001')?.deps, []);
  }
  {
    const b = board([item('T-0001', { stage: 'done', scope: 'old', evidence: [{ text: 'one', stage: 'built' }, { text: 'two', stage: 'done' }] })]);
    const out = refusal(b.root, ['edit', 'T-0001', '--scope', 'new']);
    // <stage> is substituted with the real side-stage name used by this board.
    runAdvice(b.root, out, { '<stage>': 'paused' });
    assert.notEqual(stageOf(b.store), 'done');
  }
  {
    const b = board([], { id_scheme: 'phase-seq' });
    const source = join(b.root, 'tasks.md'); writeFileSync(source, '- [ ] no phase heading\n');
    const out = refusal(b.root, ['import', source]); runAdvice(b.root, out);
    assert.equal(cli(b.root, ['config', 'id_scheme']).status, 0);
  }
  {
    const b = board(); const out = refusal(b.root, ['config', 'not.a.setting', 'x']); runAdvice(b.root, out, { '<field>': 'phase', '<code>': 'P1' });
    assert.equal(cli(b.root, ['config', '--list']).status, 0);
  }
  {
    const b = board();
    const invalid = refusal(b.root, ['config', 'check.stale_exempt_stages', '[not-json']);
    assert.equal(printed(invalid).length, 0, 'invalid list syntax is a refusal with no executable remedy');
  }
  {
    const b = board(); appendFileSync(b.store.paths.items, 'not json\n');
    const out = cli(b.root, ['repair']).output; assert.match(out, /Dry run/);
    // Dry-run text deliberately has no backtick command; the supported write
    // path is documented prose, so exercise it separately.
    assert.equal(cli(b.root, ['repair', '--write']).status, 0);
  }
});

// A refusal can be a plain error (no command), so checking only backticks
// would miss the next version of exactly the bug this file prevents.  This is
// a deliberately conservative source inventory: path + constructor count is
// stable under line movement, and names the module that must receive a case.
// It is heuristic rather than an AST: multiline constructor calls count from
// their `throw new` line, which is the project-wide convention today.
const KNOWN_REFUSAL_CONSTRUCTORS = {
  'lib/cli/args.js': 4, 'lib/cli/root.js': 3, 'lib/commands/add.js': 6,
  'lib/commands/claim.js': 2, 'lib/commands/config.js': 5, 'lib/commands/edit.js': 9,
  'lib/commands/gc.js': 1, 'lib/commands/guard.js': 1, 'lib/commands/hook.js': 4,
  'lib/commands/import.js': 7, 'lib/commands/init.js': 2, 'lib/commands/list.js': 1,
  'lib/commands/move.js': 7, 'lib/commands/next.js': 1, 'lib/commands/note.js': 2,
  'lib/commands/open.js': 1, 'lib/commands/release.js': 2, 'lib/commands/resume.js': 1,
  'lib/commands/serve.js': 2, 'lib/commands/show.js': 1, 'lib/commands/stop.js': 3,
  'lib/commands/sync.js': 1, 'lib/commands/triage.js': 5, 'lib/config.js': 1,
  'lib/ids.js': 2, 'lib/serve/invoke.js': 1, 'lib/serve/server.js': 10,
  'lib/store.js': 1, 'lib/vocab.js': 1,
};

test('the refusal inventory changes loudly when lib adds or removes a CLI error site', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const actual = {};
  for (const file of walk('lib').filter((path) => path.endsWith('.js'))) {
    const count = (readFileSync(file, 'utf8').match(/throw new (?:RuleError|UsageError|IOError)\(/g) ?? []).length;
    if (count) actual[file.replaceAll('\\', '/')] = count;
  }
  assert.deepEqual(actual, KNOWN_REFUSAL_CONSTRUCTORS,
    'A refusal constructor was added, removed, or moved. Add an executable advice case above, or explicitly document why the new site has no command.');
  const ruleFailures = (readFileSync('lib/rules.js', 'utf8').match(/failures\.push\(/g) ?? []).length;
  assert.equal(ruleFailures, 7,
    'A rule-generated refusal was added or removed. Add an executable move-gate case and record whether it prints a command.');
});
