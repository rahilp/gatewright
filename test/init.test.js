import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readTemplate } from '../lib/templates.js';

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
  run(['init'], root);
  assert.ok(!existsSync(join(root, 'CLAUDE.md')));
  assert.ok(!existsSync(join(root, '.cursor')));
  assert.ok(!existsSync(join(root, '.github')));
});

test('init updates instruction files only where the file or its parent directory already exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-init-'));
  writeFileSync(join(root, 'CLAUDE.md'), '# Claude rules\n\nBe terse.\n');
  mkdirSync(join(root, '.cursor', 'rules'), { recursive: true });
  mkdirSync(join(root, '.github'));
  mkdirSync(join(root, 'other-project', '.cursor'), { recursive: true });

  run(['init'], root);

  const claude = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.startsWith('# Claude rules\n\nBe terse.\n'), 'existing CLAUDE.md content must be preserved');
  assert.ok(claude.includes(readTemplate('agents-block.md')));
  assert.ok(readFileSync(join(root, '.cursor', 'rules', 'gatewright.mdc'), 'utf8').includes(readTemplate('agents-block.md')));
  assert.ok(readFileSync(join(root, '.github', 'copilot-instructions.md'), 'utf8').includes(readTemplate('agents-block.md')));
  assert.ok(!existsSync(join(root, 'other-project', '.cursor', 'rules')), 'a bare .cursor/ must not gain a rules/ directory');
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
