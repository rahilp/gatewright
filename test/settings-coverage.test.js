import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, SETTINGS_BY_KEY, FILE_ONLY, getValue } from '../lib/settings.js';
import { run as config } from '../lib/commands/config.js';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const TEMPLATE = JSON.parse(readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'));

function isFileOnly(path) {
  return FILE_ONLY.some((entry) => path === entry.key || path.startsWith(`${entry.key}.`));
}

// A scalar leaf is a value `gw config <key> <value>` could set. An object
// recurses unless the path itself is on the exclusion list; an array is one
// list leaf (edited comma-separated), exactly as SETTINGS declares them.
function leaves(node, prefix = '') {
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isFileOnly(path)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) out.push(...leaves(value, path));
    else out.push(path);
  }
  return out;
}

function board() {
  const root = mkdtempSync(join(tmpdir(), 'gw-settings-coverage-'));
  const store = createStore(root);
  store.ensure();
  writeFileSync(store.paths.config, readFileSync(new URL('../templates/config.json', import.meta.url), 'utf8'));
  return { root, store };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, read: () => text };
}

// T-0005 — the guard block, check.*, brief.max_lines, the github.* scalars and
// memory.* all really exist in config.json but used to answer "unknown
// setting", so tuning them meant hand-editing the file every `gw brief` says
// never to hand-edit. This suite is the guard against recurrence: every
// scalar or list leaf in the template must be reachable through `gw config`,
// either declared in SETTINGS or named on the explicit FILE_ONLY list.
test('every scalar or list leaf in templates/config.json is settable or explicitly excluded', () => {
  const declared = new Set(SETTINGS.map((setting) => setting.key));
  const unreachable = leaves(TEMPLATE).filter((path) => !declared.has(path));
  assert.deepEqual(unreachable, [], 'these config.json keys exist but gw config rejects them; declare them in SETTINGS or exclude them in FILE_ONLY with a reason');
});

test('every exclusion names a path that really exists in the template', () => {
  for (const { key, reason } of FILE_ONLY) {
    const node = getValue(TEMPLATE, key);
    assert.ok(node !== undefined, `FILE_ONLY excludes ${key}, which is not in templates/config.json; the list has rotted`);
    assert.ok(reason.trim().length > 0, `${key} is excluded without a reason`);
  }
});

test('the exclusion list and SETTINGS do not overlap, and SETTINGS keys are unique', () => {
  const keys = SETTINGS.map((setting) => setting.key);
  assert.equal(new Set(keys).size, keys.length, 'a duplicated key would be asked about twice in the wizard');
  for (const { key } of FILE_ONLY) {
    assert.ok(!SETTINGS_BY_KEY.has(key), `${key} is both declared and excluded`);
  }
});

test('every declared key resolves in templates/config.json', () => {
  const missing = SETTINGS.map((setting) => setting.key).filter((key) => getValue(TEMPLATE, key) === undefined);
  assert.deepEqual(missing, [], 'a declared key absent from the template cannot be set on a fresh board');
});

test('gw config --list names the file-only structures instead of pretending they do not exist', async () => {
  const { store } = board();
  const stdout = capture();
  const code = await config({ store, positionals: [], flags: { list: true }, stdout });
  assert.equal(code, 0);
  const lines = stdout.read().split('\n');
  assert.ok(lines.includes('not settable here (structures in .gatewright/config.json): github.labels, memory.providers, runner.providers, version'),
    `the file-only note is missing or misworded; got:\n${stdout.read()}`);
  for (const { key } of FILE_ONLY) {
    if (key === 'glossary') continue; // glossary entries are listed per code above the note
    assert.ok(stdout.read().includes(key), `${key} must be named in the --list note`);
  }
});

test('the previously unreachable keys now read, write and validate like any other setting', async () => {
  const { root, store } = board();
  store.rebaselineDigest();
  for (const [key, value] of [
    ['guard.enabled', 'false'],
    ['guard.mode', 'warn'],
    ['guard.accept', 'message,owner'],
    ['guard.exempt_paths', '.gatewright/,vendor/'],
    ['check.stale_days', '14'],
    ['check.stale_exempt_stages', 'merged,verified'],
    ['brief.max_lines', '40'],
    ['github.dispatch_label', 'agent/please'],
    ['github.comment_on_move', 'false'],
    ['memory.provider', 'second-brain'],
  ]) {
    const stdout = capture();
    const code = await config({ store, positionals: [key, value], flags: {}, stdout });
    assert.equal(code, 0, `${key} should be settable`);
  }
  const saved = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  assert.equal(saved.guard.enabled, false);
  assert.equal(saved.guard.mode, 'warn');
  assert.deepEqual(saved.guard.accept, ['message', 'owner']);
  assert.deepEqual(saved.guard.exempt_paths, ['.gatewright/', 'vendor/']);
  assert.equal(saved.check.stale_days, 14);
  assert.deepEqual(saved.check.stale_exempt_stages, ['merged', 'verified']);
  assert.equal(saved.brief.max_lines, 40);
  assert.equal(saved.github.dispatch_label, 'agent/please');
  assert.equal(saved.github.comment_on_move, false);
  assert.equal(saved.memory.provider, 'second-brain');
  // A gw config write re-baselines the digest, so none of this may read as an
  // out-of-band write to `gw check`.
  const out = execFileSync(process.execPath, [BIN, 'check'], { cwd: root, encoding: 'utf8' });
  assert.equal(out, 'Board is clean.\n');
});

test('a choice-bearing key and an out-of-range integer are still refused', async () => {
  const { store } = board();
  await assert.rejects(() => config({ store, flags: {}, positionals: ['guard.mode', 'silent'] }), /must be one of: block, warn/);
  await assert.rejects(() => config({ store, flags: {}, positionals: ['brief.max_lines', '3'] }), /at least 4/);
  await assert.rejects(() => config({ store, flags: {}, positionals: ['check.stale_days', '400'] }), /at most 365/);
  await assert.rejects(() => config({ store, flags: {}, positionals: ['memory.provider', 'nope'] }), /must be one of: second-brain/);
});
