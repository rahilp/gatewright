import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRETOOL_COMMAND } from '../lib/commands/hook.js';

const plugin = JSON.parse(readFileSync(new URL('../adapters/claude-code/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
const hooks = JSON.parse(readFileSync(new URL('../adapters/claude-code/hooks/hooks.json', import.meta.url), 'utf8'));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// T-0104 — a bare `gw guard --pretool` in a PreToolUse hook makes a machine
// whose gw is missing or too old refuse every Edit and Write: gw's usage
// exit 2 is what Claude Code reads as "this tool call was denied". `gw hook
// install` was fixed in v0.13 to install the two-step probe instead; the
// plugin adapter shipped the defect for another release because nothing tied
// the two copies together. This test is that tie: the adapter does not get to
// carry its own idea of how the guard is invoked.
test('the Claude Code plugin invokes the guard exactly as gw hook install does', () => {
  const pretool = hooks.hooks.PreToolUse[0].hooks[0];
  assert.equal(pretool.type, 'command');
  assert.equal(pretool.command, PRETOOL_COMMAND);
});

test('the plugin hook still matches the file-writing tools and starts a session with gw brief', () => {
  assert.equal(hooks.hooks.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit');
  assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, 'gw brief');
});

// The bare command is the defect itself: if it reappears anywhere in the
// manifest, a stale gw makes the repository uneditable again.
test('no hook invokes the guard unguarded', () => {
  const commands = Object.values(hooks.hooks).flat().flatMap((entry) => entry.hooks).map((hook) => hook.command);
  assert.ok(!commands.includes('gw guard --pretool'), 'a bare `gw guard --pretool` is the T-0104 defect');
});

// A plugin version that lags the package is a user reading release notes for
// a plugin they do not have.
test('the plugin manifest version is the package version', () => {
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.name, 'gatewright');
});
