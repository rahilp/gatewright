import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTemplate } from '../lib/templates.js';
import { run as init } from '../lib/commands/init.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const DATA = ['.gatewright/items.jsonl', '.gatewright/events.jsonl', '.gatewright/stages.json', '.gatewright/config.json', '.gatewright/prompt.md', '.gatewright/.digest'];

const run = (args, cwd) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GW_ROOT: '' } });
const digest = (root, files) => files.map((f) => {
  const path = join(root, f);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
});

test('init creates .gatewright/ from the shipped templates and writes the block to AGENTS.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  const out = run(['init'], root);
  assert.ok(existsSync(join(root, '.gatewright')), '.gatewright/ must exist');
  assert.equal(readFileSync(join(root, '.gatewright', 'items.jsonl'), 'utf8'), '');
  assert.equal(readFileSync(join(root, '.gatewright', 'events.jsonl'), 'utf8'), '');
  for (const file of ['stages.json', 'config.json', 'prompt.md']) {
    assert.equal(readFileSync(join(root, '.gatewright', file), 'utf8'), readTemplate(file), `${file} must be the shipped template`);
  }
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(readTemplate('agents-block.md')));
  assert.match(out, /next/i);
});

test('init never creates uninvited instruction files', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  const out = run(['init'], root);
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  assert.ok(!existsSync(join(root, '.cursor')));
  assert.ok(!existsSync(join(root, '.github')));
  assert.match(out, /skipped Claude, Cursor and Copilot/);
  assert.match(out, /--mirror claude,cursor,copilot/);
});

test('init updates only provider artifacts that already exist, with provider-owned directory evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude rules\n\nBe terse.\n');
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'other-project', '.cursor'), { recursive: true });

  const out = run(['init'], root);

  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# Claude rules\n\nBe terse.\n'), 'existing CLAUDE.md content must be preserved');
  assert.ok(claude.includes(readTemplate('agents-block.md')));
  assert.ok(readFileSync(join(root, '.cursor', 'rules', 'gatewright.mdc'), 'utf8').includes(readTemplate('agents-block.md')));
  assert.ok(!existsSync(join(root, '.github', 'copilot-instructions.md')));
  assert.match(out, /skipped Copilot/);
  assert.match(out, /--mirror copilot/);
  assert.ok(!existsSync(join(root, 'other-project', '.cursor', 'rules')), 'a bare .cursor/ must not gain a rules/ directory');
});

test('init updates an existing Copilot file and preserves surrounding content', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github', 'copilot-instructions.md'), '# Copilot rules\n\nKeep this.\n');

  run(['init'], root);

  const copilot = readFileSync(join(root, '.github', 'copilot-instructions.md'), 'utf8');
  assert.ok(copilot.startsWith('# Copilot rules\n\nKeep this.\n'));
  assert.ok(copilot.includes(readTemplate('agents-block.md')));
});

test('init --mirror creates the requested mirrors and accepts all', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  const out = run(['init', '--mirror', 'all'], root);

  for (const file of ['CLAUDE.md', join('.cursor', 'rules', 'gatewright.mdc'), join('.github', 'copilot-instructions.md')]) {
    assert.ok(existsSync(join(root, file)), `${file} must be created`);
  }
  assert.ok(out.includes('CLAUDE.md'));
  assert.ok(out.includes('gatewright.mdc'));
  assert.ok(out.includes('copilot-instructions.md'));
});

test('init --mirror copilot creates .github and its instruction file when requested', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  run(['init', '--mirror', 'copilot'], root);
  assert.ok(existsSync(join(root, '.github', 'copilot-instructions.md')));
});

test('init --mirror nonsense is a usage error naming valid targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  try {
    run(['init', '--mirror', 'nonsense'], root);
    assert.fail('expected a usage error');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /claude, cursor, copilot, all/);
  }
});

test('a second init changes nothing and says so', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  run(['init'], root);
  const before = digest(root, [...DATA, 'AGENTS.md', 'CLAUDE.md']);
  const out = run(['init'], root);
  assert.match(out, /already exists/);
  assert.match(out, /--force/);
  assert.deepEqual(digest(root, [...DATA, 'AGENTS.md', 'CLAUDE.md']), before);
});

test('--force replaces the instruction blocks and leaves data files untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  run(['init'], root);
  writeFileSync(join(root, 'AGENTS.md'), `# Agent rules\n\n<!-- gatewright:start -->\n## Work tracking\nstale wording from an older release\n<!-- gatewright:end -->\n\nTrailing section.\n`);
  writeFileSync(join(root, '.gatewright', 'prompt.md'), 'MY CUSTOM PROMPT {{title}}\n');
  writeFileSync(join(root, '.gatewright', 'stages.json'), '{"stages": [], "terminal": [], "extra": []}\n');
  const before = digest(root, DATA);

  const out = run(['init', '--force'], root);

  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(readTemplate('agents-block.md')), 'the block must be restored');
  assert.ok(!readFileSync(join(root, 'AGENTS.md'), 'utf8').includes('stale wording'));
  assert.equal(readFileSync(join(root, '.gatewright', 'prompt.md'), 'utf8'), 'MY CUSTOM PROMPT {{title}}\n');
  assert.equal(readFileSync(join(root, '.gatewright', 'stages.json'), 'utf8'), '{"stages": [], "terminal": [], "extra": []}\n');
  assert.deepEqual(digest(root, DATA), before);
  assert.match(out, /refreshed|replaced/);
});

test('init fails cleanly on a malformed AGENTS.md without creating .gatewright/', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  writeFileSync(join(root, 'AGENTS.md'), '# Agent rules\n\n<!-- gatewright:start -->\nbroken block with no end marker\n');
  try {
    run(['init'], root);
    assert.fail('expected a non-zero exit');
  } catch (err) {
    assert.equal(err.status, 3);
    assert.match(String(err.stderr), /with no <!-- gatewright:(start|end) --> marker/);
    assert.ok(!existsSync(join(root, '.gatewright')), 'nothing must be created when AGENTS.md is malformed');
  }
});

test('init creates the root at ctx.cwd, not at process.cwd()', async () => {
  const { runRouter } = await import('../lib/cli/router.js');
  const target = mkdtempSync(join(tmpdir(), 'gw-init-cwd-'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'gw-init-elsewhere-'));
  let out = '';
  const previousCwd = process.cwd();
  process.chdir(elsewhere); // even a wrong process.cwd() must not become the root
  try {
    const code = await runRouter(['init'], { cwd: target, env: {}, stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } });
    assert.equal(code, 0);
  } finally {
    process.chdir(previousCwd);
  }
  assert.ok(existsSync(join(target, '.gatewright')), 'the root must be created at ctx.cwd');
  assert.ok(!existsSync(join(elsewhere, '.gatewright')), 'process.cwd() must never be used');
  assert.match(out, /initialized/);
});

function initWithGh(root, flags, ghRun) {
  let output = '';
  init({ flags, cwd: root, ghRun, stdout: { write(value) { output += value; } } });
  return output;
}

test('init --gh enables the default label map for a GitHub origin without invoking real gh', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:owner/from-remote.git\n');
  const calls = [];
  const out = initWithGh(root, { gh: true }, (argv) => { calls.push(argv); return { stdout: '', status: 0 }; });
  const config = JSON.parse(readFileSync(join(root, '.gatewright', 'config.json')));
  assert.deepEqual(calls, [['auth', 'status']]);
  assert.equal(config.github.enabled, true);
  assert.equal(config.github.repo, 'owner/from-remote');
  assert.deepEqual(config.github.labels, { 'priority/P0': { priority: 'P0' }, 'type/defect': { type: 'defect' }, 'phase/2': { phase: 'P2' } });
  assert.match(out, /enabled GitHub sync/);
});

test('init --gh --repo overrides origin discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  mkdirSync(join(root, '.git'));
  writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/wrong/repo.git\n');
  initWithGh(root, { gh: true, repo: 'right/repo' }, () => ({ stdout: '', status: 0 }));
  assert.equal(JSON.parse(readFileSync(join(root, '.gatewright', 'config.json'))).github.repo, 'right/repo');
});

test('init --gh leaves a working tracker with GitHub disabled when gh is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  const out = initWithGh(root, { gh: true, repo: 'owner/repo' }, () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; });
  assert.ok(existsSync(join(root, '.gatewright', 'items.jsonl')));
  assert.equal(JSON.parse(readFileSync(join(root, '.gatewright', 'config.json'))).github.enabled, false);
  assert.match(out, /not installed.*gh auth login/i);
});

test('init --gh can enable GitHub on an existing tracker', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  initWithGh(root, {}, () => { throw new Error('not called'); });
  initWithGh(root, { gh: true, repo: 'owner/repo' }, () => ({ stdout: '', status: 0 }));
  assert.equal(JSON.parse(readFileSync(join(root, '.gatewright', 'config.json'))).github.enabled, true);
});

// Every write init performs must re-baseline the digest, or gw's own command
// is reported as tampering on the next check.
test('a freshly initialized board checks clean, with no out-of-band report', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  run(['init'], root);
  assert.equal(run(['check'], root), 'Board is clean.\n');
});

test('init --gh on an existing tracker re-baselines the digest, so gw check stays clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  initWithGh(root, {}, () => { throw new Error('not called'); });
  run(['check'], root);
  const before = readFileSync(join(root, '.gatewright', '.digest'), 'utf8');
  initWithGh(root, { gh: true, repo: 'owner/repo' }, () => ({ stdout: '', status: 0 }));
  assert.notEqual(readFileSync(join(root, '.gatewright', '.digest'), 'utf8'), before, 'the config write must have re-baselined the digest');
  assert.equal(run(['check'], root), 'Board is clean.\n');
});

test('the usage text advertises --gh now that P3-08 has landed', () => {
  const help = run(['--help'], mkdtempSync(join(tmpdir(), 'gw-init-')));
  assert.ok(help.includes('--gh'));
});
