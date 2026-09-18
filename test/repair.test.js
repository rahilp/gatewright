import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

const good1 = { id: 'T-0001', title: 'Good one', stage: 'backlog', deps: [], evidence: [] };
const good3 = { id: 'T-0003', title: 'Good three', stage: 'backlog', deps: [], evidence: [] };
const BAD_ITEMS_LINE = '{"id": "T-0002", "title":';
const BAD_EVENTS_LINE = 'this line is not json at all';

function makeBoard() {
  const root = mkdtempSync(join(tmpdir(), 'gw-repair-'));
  const store = createStore(root);
  store.ensure();
  // Baseline the digest on the CLEAN board first: the corruption below is
  // then genuinely out-of-band, which is the state a corrupt board is found in.
  store.writeItems([good1, good3]);
  store.rebaselineDigest();
  // Corrupt both audited files: one unparseable line each.
  const items = readFileSync(store.paths.items, 'utf8');
  writeFileSync(store.paths.items, `${items}${BAD_ITEMS_LINE}\n`);
  writeFileSync(store.paths.events, `${JSON.stringify({ type: 'add', item: 'T-0001' })}\n${BAD_EVENTS_LINE}\n`);
  return { root, store };
}

function runCli(root, args) {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: root,
    env: { ...process.env, GW_ACTOR: 'human:tester' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('repair is a dry run by default: it reports every bad line and changes nothing', async () => {
  const b = makeBoard();
  const result = await runCli(b.root, ['repair']);
  assert.match(result.stdout, /items\.jsonl: line 3 not valid JSON/);
  assert.match(result.stdout, /events\.jsonl: line 2 not valid JSON/);
  assert.match(result.stdout, /Dry run — nothing changed/);
  assert.match(result.stdout, /--write/);
  assert.equal(readFileSync(b.store.paths.items, 'utf8').includes(BAD_ITEMS_LINE), true, 'items.jsonl is untouched');
  assert.equal(readFileSync(b.store.paths.events, 'utf8').includes(BAD_EVENTS_LINE), true, 'events.jsonl is untouched');
  assert.equal(existsSync(b.store.paths.quarantine), false, 'a dry run writes no quarantine file');
});

test('repair --write quarantines the bad lines, keeps the good ones, and the board loads again', async () => {
  const b = makeBoard();
  const result = await runCli(b.root, ['repair', '--write']);
  assert.equal(result.code, 0, result.stderr);

  const quarantined = readFileSync(b.store.paths.quarantine, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(quarantined.map((entry) => [entry.file, entry.line]), [['items.jsonl', 3], ['events.jsonl', 2]]);
  assert.equal(quarantined[0].raw, BAD_ITEMS_LINE, 'the raw line survives byte-for-byte in quarantine — never destroy a user\'s data to fix their file');
  assert.equal(quarantined[1].raw, BAD_EVENTS_LINE);

  const items = readFileSync(b.store.paths.items, 'utf8').trim().split('\n');
  assert.deepEqual(items.map((line) => JSON.parse(line).id), ['T-0001', 'T-0003'], 'the good lines survive the rewrite');
  assert.equal(readFileSync(b.store.paths.events, 'utf8').includes(BAD_EVENTS_LINE), false);

  // The point of the command: the board reads cleanly again.
  const list = await runCli(b.root, ['list']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /T-0001/);
  assert.match(list.stdout, /T-0003/);
});

test('a repair --write does not read as tampering afterwards', async () => {
  const b = makeBoard();
  await runCli(b.root, ['repair', '--write']);
  // The digest covered the corrupted files (the corruption was out-of-band);
  // the repair rewrote them, so it must re-baseline or the very next check
  // accuses the tool's own repair of being a hand edit.
  const check = await runCli(b.root, ['check']);
  assert.doesNotMatch(check.stdout, /out-of-band write/, check.stdout);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /Board is clean/);

  const config = await runCli(b.root, ['config', '--list']);
  assert.equal(config.code, 0, config.stderr);
  assert.doesNotMatch(config.stdout + config.stderr, /out-of-band write/);
});

test('a clean board has nothing for repair to do', async () => {
  const b = makeBoard();
  writeFileSync(b.store.paths.items, `${JSON.stringify(good1)}\n`);
  writeFileSync(b.store.paths.events, '');
  const result = await runCli(b.root, ['repair']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Nothing to repair/);
});
