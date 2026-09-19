import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTemplate } from '../lib/templates.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const DATA = ['.gatewright/items.jsonl', '.gatewright/events.jsonl', '.gatewright/stages.json', '.gatewright/config.json', '.gatewright/prompt.md', '.gatewright/.digest'];
// Forward-slash relative paths: that is how init and upgrade name these files
// to the user on every platform. Node accepts them for filesystem calls on
// Windows too, so the same list serves both the join and the output match.
const MIRRORS = ['CLAUDE.md', '.cursor/rules/gatewright.mdc', '.github/copilot-instructions.md'];

const run = (args, cwd) => execFileSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, GW_ROOT: '' } });
const digest = (root, files) => files.map((f) => {
  const path = join(root, f);
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';
});
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => {
    const rel = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? walk(join(dir, entry.name), rel) : [rel];
  })
  .sort();

// An initialized repo with one item, a custom prompt template, a stale board,
// and an AGENTS.md carrying an outdated block — the state upgrade must fix the
// shell and the block while leaving every byte of data alone.
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'gw-upgrade-'));
  run(['init'], root);
  writeFileSync(join(root, '.gatewright', 'items.jsonl'), JSON.stringify({ id: 'P1-01', title: 'Upgrade the shell', stage: 'built', evidence: ['abc123'] }) + '\n');
  writeFileSync(join(root, '.gatewright', 'events.jsonl'), JSON.stringify({ type: 'add', item: 'P1-01', by: 'human:rahil' }) + '\n');
  writeFileSync(join(root, '.gatewright', 'prompt.md'), 'MY CUSTOM PROMPT {{title}}\n');
  writeFileSync(join(root, '.gatewright', 'board.html'), '<!-- gatewright board v0 -->\n<html><body>stale shell</body></html>\n');
  writeFileSync(join(root, 'AGENTS.md'), `# Agent rules\n\n<!-- gatewright:start -->\n## Work tracking\nstale wording from an older release\n<!-- gatewright:end -->\n\nTrailing section.\n`);
  return root;
}

test('upgrade replaces the viewer shell, refreshes the AGENTS.md block, and leaves every data file byte-identical', () => {
  const root = repo();
  const before = digest(root, DATA);

  const out = run(['upgrade'], root);

  assert.deepEqual(digest(root, DATA), before, 'no data file may change, not even the digest');
  const board = readFileSync(join(root, '.gatewright', 'board.html'), 'utf8');
  assert.match(board, /^<!-- gatewright board v1 -->/);
  assert.ok(board.includes('P1-01'), 'the new shell must carry the current data');
  assert.ok(!board.includes('stale shell'));
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(agents.startsWith('# Agent rules\n\n'), 'content around the block must be preserved');
  assert.ok(agents.includes(readTemplate('agents-block.md')), 'the block must be refreshed');
  assert.ok(!agents.includes('stale wording'));
  assert.ok(agents.endsWith('\nTrailing section.\n'));
  assert.match(out, /viewer shell/);
  assert.match(out, /AGENTS\.md/);
  assert.ok(!out.includes('REPLACED'), 'plain upgrade must not claim it replaced the prompt');
});

test('upgrade --templates replaces prompt.md and says so loudly', () => {
  const root = repo();
  run(['upgrade'], root);
  const before = digest(root, DATA.filter((f) => f !== '.gatewright/prompt.md'));

  const out = run(['upgrade', '--templates'], root);

  assert.equal(readFileSync(join(root, '.gatewright', 'prompt.md'), 'utf8'), readTemplate('prompt.md'), 'the custom prompt must be gone');
  assert.deepEqual(digest(root, DATA.filter((f) => f !== '.gatewright/prompt.md')), before, 'everything but prompt.md must be untouched');
  assert.match(out, /prompt\.md REPLACED/);
});

test('upgrade refreshes every mirrored instruction block and creates no new files', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-upgrade-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude rules\n\nBe terse.\n');
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github', 'copilot-instructions.md'), '# Copilot rules\n');
  run(['init'], root);

  for (const file of ['AGENTS.md', ...MIRRORS]) {
    const path = join(root, file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(readTemplate('agents-block.md'), '<!-- gatewright:start -->\nstale wording from an older release\n<!-- gatewright:end -->\n'));
  }
  const before = walk(root).filter((f) => f !== join('.gatewright', 'board.html')); // the board is gatewright-owned and may be regenerated

  const out = run(['upgrade'], root);

  assert.deepEqual(walk(root).filter((f) => f !== join('.gatewright', 'board.html')), before, 'upgrade must not create (or remove) any file');
  for (const file of ['AGENTS.md', ...MIRRORS]) {
    const text = readFileSync(join(root, file), 'utf8');
    assert.ok(text.includes(readTemplate('agents-block.md')), `${file} must carry the shipped block again`);
    assert.ok(!text.includes('stale wording'), `${file} must not keep last version's instructions`);
  }
  for (const file of ['AGENTS.md', ...MIRRORS]) assert.match(out, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'upgrade must name every file it refreshed');
});

test('upgrade regenerates a missing board but never creates instruction files', () => {
  const root = repo();
  writeFileSync(join(root, 'AGENTS.md'), '# Agent rules\n\nProse with no block yet.\n');
  writeFileSync(join(root, '.gatewright', 'board.html'), '');
  run(['upgrade'], root);

  assert.match(readFileSync(join(root, '.gatewright', 'board.html'), 'utf8'), /^<!-- gatewright board v1 -->/);
  assert.ok(readFileSync(join(root, 'AGENTS.md'), 'utf8').includes(readTemplate('agents-block.md')), 'an existing AGENTS.md is refreshed');

  rmSync(join(root, 'AGENTS.md'));
  writeFileSync(join(root, '.gatewright', 'board.html'), '');
  const before = walk(root);

  const out = run(['upgrade'], root);

  assert.match(readFileSync(join(root, '.gatewright', 'board.html'), 'utf8'), /^<!-- gatewright board v1 -->/);
  assert.deepEqual(walk(root), before.filter((f) => f !== 'AGENTS.md'), 'no instruction file may be created');
  assert.match(out, /warning: AGENTS\.md is missing/);
  assert.match(out, /gw init/);
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  assert.ok(!existsSync(join(root, '.cursor')));
  assert.ok(!existsSync(join(root, '.github')));
});
