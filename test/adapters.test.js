import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunner } from '../lib/run/spawn.js';
import { readTemplate } from '../lib/templates.js';

const root = mkdtempSync(join(tmpdir(), 'gw-adapters-'));
mkdirSync(join(root, '.gatewright'), { recursive: true });
writeFileSync(join(root, '.gatewright', 'prompt.md'), 'smoke prompt');
const item = { id: 'P4-12', title: 'provider smoke', scope: '', stage: 'building', deps: [], notes: '' };

test('shipped providers produce exact argv through the committed spawn boundary', () => {
  const config = JSON.parse(readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'));
  const expected = {
    claude: ['claude', '-p', 'smoke prompt', '--allowedTools', 'Edit,Bash'],
    codex: ['codex', 'exec', 'smoke prompt'],
    custom: ['./scripts/run-agent.sh', 'P4-12'],
  };
  for (const [provider, argv] of Object.entries(expected)) {
    const result = createRunner({ dryRun: true }).start({
      config: { ...config, runner: { ...config.runner, provider } }, item, run: 'r-1', worktree: root, root,
    });
    assert.deepEqual(result.argv, argv, provider);
  }
});

test('Claude Code plugin hook is valid and gw brief resolves', () => {
  const manifest = JSON.parse(readFileSync(new URL('../adapters/claude-code/.claude-plugin/plugin.json', import.meta.url)));
  const hooks = JSON.parse(readFileSync(new URL('../adapters/claude-code/hooks/hooks.json', import.meta.url)));
  assert.equal(manifest.name, 'gatewright');
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'gw brief');
  assert.equal(existsSync(new URL('../bin/gw.js', import.meta.url)), true, 'the shipped gw command exists');
});

test('Cursor adapter is byte-identical to the single source template', () => {
  const adapter = readFileSync(new URL('../adapters/cursor/.cursor/rules/gatewright.mdc', import.meta.url));
  const template = readFileSync(new URL('../templates/agents-block.md', import.meta.url));
  assert.deepEqual(adapter, template);
});

test('Codex and generic adapters are documentation only', () => {
  assert.match(readFileSync(new URL('../adapters/codex/README.md', import.meta.url), 'utf8'), /AGENTS\.md/);
  assert.match(readFileSync(new URL('../adapters/generic/README.md', import.meta.url), 'utf8'), /AGENTS\.md/);
  assert.equal(existsSync(join(root, 'adapters')), false);
});
