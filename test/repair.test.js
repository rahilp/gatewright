import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { runPrintedCommand } from './helpers/printed-command.js';

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

// T-0086 — this is the real laundering sequence: a forged terminal item can
// satisfy every stage rule, so only the digest distinguishes it from a CLI
// move. `check` must preserve that known-stale baseline and repair must not
// adopt the surviving forgery merely because it quarantined a later bad line.
test('the re-baseline command repair prints runs verbatim from that state and leaves check clean', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-repair-launder-'));
  const store = createStore(root);
  store.ensure();
  store.writeItems([good1]);

  const forged = {
    id: 'T-0001', title: 'Forged verified item', stage: 'verified', flag: null,
    owner: 'human:tester', scope: 'fully forged but shape-valid', deps: [],
    evidence: [
      { text: 'commit abc123', stage: 'built' },
      { text: 'https://github.com/acme/app/pull/1', stage: 'in_review' },
      { text: 'CI green', stage: 'verified' },
      { text: 'deployed to target', stage: 'verified' },
    ],
  };
  writeFileSync(store.paths.items, `${JSON.stringify(forged)}\n`);

  const initialCheck = await runCli(root, ['check']);
  assert.equal(initialCheck.code, 1);
  assert.match(initialCheck.stdout, /OUT-OF-BAND WRITE[\s\S]*items\.jsonl modified outside gw/);

  appendFileSync(store.paths.items, 'not valid json\n');
  const repair = await runCli(root, ['repair', '--write']);
  assert.equal(repair.code, 1);
  assert.match(repair.stdout, /line 2 quarantined/);
  assert.match(repair.stdout, /digest remains stale[\s\S]*gw check[\s\S]*repair --write --force/);

  const printed = repair.stdout.match(/After deliberate review, run `([^`]+)` to re-baseline\./);
  assert.ok(printed, 'repair prints one follow-up command');
  const forced = runPrintedCommand(root, printed[1], { ...process.env, GW_ACTOR: 'human:tester' });
  assert.equal(forced.error, undefined, forced.error?.message);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.match(forced.stdout, /Digest re-baselined by explicit recovery/);

  const finalCheck = await runCli(root, ['check']);
  assert.equal(finalCheck.code, 0, finalCheck.stdout + finalCheck.stderr);
  assert.equal(finalCheck.stdout, 'Board is clean.\n');
});

test('a clean board has nothing for repair to do', async () => {
  const b = makeBoard();
  writeFileSync(b.store.paths.items, `${JSON.stringify(good1)}\n`);
  writeFileSync(b.store.paths.events, '');
  const result = await runCli(b.root, ['repair']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Nothing to repair/);
});

test('repair --write clears stale terminal triage holds and records each flag event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-repair-triage-'));
  const store = createStore(root); store.ensure();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog' }, { id: 'done', role: 'done' }], terminal: [], extra: [{ id: 'dropped', role: 'dropped' }] }));
  store.writeItems([
    { ...good1, id: 'T-0109', stage: 'done', flag: 'needs-triage' },
    { ...good3, id: 'T-0110', stage: 'backlog', flag: 'needs-triage' },
  ]);

  const dry = await runCli(root, ['repair']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /T-0109 is finished in done but still has needs-triage/);
  assert.match(dry.stdout, /Dry run — nothing changed/);
  assert.equal(store.readItems().find((entry) => entry.id === 'T-0109')?.flag, 'needs-triage');

  const write = await runCli(root, ['repair', '--write']);
  assert.equal(write.code, 0, write.stderr);
  assert.match(write.stdout, /cleared 1 stale triage hold.*recorded flag events/);
  assert.equal(store.readItems().find((entry) => entry.id === 'T-0109')?.flag, null);
  assert.equal(store.readItems().find((entry) => entry.id === 'T-0110')?.flag, 'needs-triage', 'open triage work is untouched');
  const event = store.readEvents().find((entry) => entry.item === 'T-0109' && entry.reason === 'stale triage hold cleared from finished item');
  assert.deepEqual({ type: event?.type, flag: event?.flag, by: event?.by }, { type: 'flag', flag: null, by: 'human:tester' });
});

// T-0071 — repair used to quarantine only unparseable lines, then re-baseline
// the digest: a line of VALID JSON with an invalid stage became permanent
// truth, and check blessed it. Now repair reports content-invalid lines
// (without quarantining them — the board still loads, and removing an item is
// an edit nobody directed), and check judges shape independently of the
// digest, so the re-baseline legitimises nothing.
test('a valid-JSON line with an invalid stage is reported by repair and still fails check after the re-baseline', async () => {
  const b = makeBoard();
  const FORGED = JSON.stringify({ id: 'T-0099', title: 'forged', stage: 'nonsense', deps: [], evidence: [] });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(b.store.paths.items, `${FORGED}\n`);

  const dry = await runCli(b.root, ['repair']);
  assert.match(dry.stdout, /line 4 has stage "nonsense", which is not a stage on this board/);
  assert.match(dry.stdout, /reported, not quarantined/);

  const write = await runCli(b.root, ['repair', '--write']);
  assert.equal(write.code, 1, 'content-invalid lines keep repair --write from reporting success');
  assert.match(write.stdout, /line 2 quarantined/, 'the unparseable line is still quarantined');
  assert.match(write.stdout, /line 4 has stage "nonsense".*reported, not quarantined/);
  assert.equal(readFileSync(b.store.paths.items, 'utf8').includes(FORGED), true, 'nothing was deleted: the line survives in place');

  // The point of the fix: repair's digest re-baseline does not launder the
  // forged item — check fails on shape, every time.
  const check = await runCli(b.root, ['check']);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /INVALID STAGE[\s\S]*T-0099/);
  assert.match(check.stdout, /nonsense/);
});
