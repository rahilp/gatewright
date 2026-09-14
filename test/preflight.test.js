import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { helpCommands, runPreflight, usageCommandEntries } from '../scripts/preflight.mjs';

function write(root, file, content) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function fixture({ version = '1.2.3', readme = '# Gatewright\n\n## Status\n\nGatewright is at v1.2.3.\n\n| Command | What it does |\n| --- | --- |\n| `gw init` | Create a board |\n', help = '  init  create a board', binary } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gatewright-preflight-'));
  write(root, 'package.json', JSON.stringify({
    name: 'preflight-fixture', version, type: 'module', bin: { gw: 'bin/gw.js' }, files: ['bin/'], scripts: { test: 'node --test' },
  }, null, 2));
  write(root, 'README.md', readme);
  write(root, 'LICENSE', 'MIT\n');
  write(root, 'bin/gw.js', binary ?? `#!/usr/bin/env node\nif (process.argv[2] === '--help') console.log(${JSON.stringify(help)});\n`);
  write(root, 'lib/commands/init.js', 'export const spec = {};\n');
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'tests@example.invalid');
  git(root, 'config', 'user.name', 'Preflight Tests');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'fixture');
  return root;
}

function assertFailure(root, expected) {
  assert.match(runPreflight({ root }).join('\n'), expected);
}

test('fails when README status claims a different version', () => {
  assertFailure(fixture({ readme: '# Gatewright\n\n## Status\n\nGatewright is at v9.9.9.\n\n| Command | What it does |\n| --- | --- |\n| `gw init` | Create a board |\n' }), /README\.md:\d+: claims version v9\.9\.9/);
});

test('fails when a shipped file contains a local path', () => {
  assertFailure(fixture({ readme: '# Gatewright\n\n## Status\n\nGatewright is at v1.2.3.\n\n/home/rahil/private\n\n| Command | What it does |\n| --- | --- |\n| `gw init` | Create a board |\n' }), /README\.md: contains a local path/);
});

test('fails when README calls a shipped command not yet', () => {
  assertFailure(fixture({ readme: '# Gatewright\n\n## Status\n\nGatewright is at v1.2.3.\n\n| Command | What it does |\n| --- | --- |\n| `gw init` | **not yet** |\n' }), /marks `gw init` as not yet, but gw --help lists it/);
});

test('accepts a not-yet command that is absent from --help', () => {
  const root = fixture({ readme: '# Gatewright\n\n## Status\n\nGatewright is at v1.2.3.\n\n| Command | What it does |\n| --- | --- |\n| `gw future` | **not yet** |\n' });
  assert.deepEqual(runPreflight({ root }), []);
});

test('parses aliases and long usage lines without relying on columns', () => {
  const commands = helpCommands([
    '  init [--gh] [--repo owner/name] [--force] create the board',
    '  edit <id> [--title ...] [--scope ...] change an item',
    '  claim <id> | release <id>             take or drop ownership',
    '  show <id> | list [--stage S]          read items',
  ].join('\n'));
  assert.deepEqual(commands, new Set(['init', 'edit', 'claim', 'release', 'show', 'list']));
  assert.deepEqual(usageCommandEntries('  show <id> | list [--stage S]          read items').map((entry) => entry.name), ['show', 'list']);
});

test('fails when a command has duplicate usage entries', () => {
  const root = fixture({ help: '  init  create a board\n  init  create a board again' });
  assertFailure(root, /gw --help: command `init` appears 2 times/);
});

test('fails when usage and command modules disagree', () => {
  const root = fixture({ help: '  init  create a board\n  ghost  not implemented' });
  write(root, 'lib/commands/orphan.js', 'export const spec = {};\n');
  assertFailure(root, /lib\/commands\/orphan\.js: command module is absent from gw --help/);
  assertFailure(root, /gw --help: advertises `ghost`, but lib\/commands\/ghost\.js is absent/);
});

test('fails when an advertised import format is rejected by the binary', () => {
  const binary = `#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--help') console.log('  import <file> [--format md|csv] ingest items');
else if (args[0] === 'init') mkdirSync('.gatewright');
else if (args[0] === 'import' && args[args.indexOf('--format') + 1] === 'csv') process.exitCode = 2;
`;
  assertFailure(fixture({ help: '  import <file> [--format md|csv] ingest items', binary }), /advertises `--format csv`, but the binary rejects it/);
});

test('fails on a dirty tree', () => {
  const root = fixture();
  write(root, 'uncommitted.txt', 'dirty\n');
  assertFailure(root, /working tree is dirty/);
});

test('fails on a dev version', () => {
  assertFailure(fixture({ version: '1.2.3-dev', readme: '# Gatewright\n\n## Status\n\nGatewright is at v1.2.3.\n\n| Command | What it does |\n| --- | --- |\n| `gw init` | Create a board |\n' }), /version 1\.2\.3-dev is a placeholder/);
});
