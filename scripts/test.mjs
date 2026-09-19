// Enumerate test files in JS rather than relying on a shell glob.
// PowerShell does not expand globs, and `node --test` only learned to expand
// them itself in Node 22 — so `node --test test/*.test.js` runs nothing on
// Windows with Node 18 or 20 and exits 1 having tested precisely zero code.
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withoutCallerState } from '../test/helpers/isolate-env.js';

const dir = 'test';
// Test-only injection lets the runner's own signal and cleanup path be
// verified without recursively launching the complete suite.
const files = process.env.GW_TEST_FILES
  ? JSON.parse(process.env.GW_TEST_FILES)
  : readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort().map((name) => join(dir, name));
if (files.length === 0) { console.error('no test files found in test/'); process.exit(1); }

// A global backstop: a test that spawns a real process and never gets a signal it expects
// (a platform difference in signal/kill semantics, an unresponsive external command) must
// fail with a message, not hang until the CI job itself is killed (see P6-05). Generous
// enough to clear the suite's own multi-second polling waits with room to spare.
// --test-timeout is a backstop against a hung test, but it does not exist
// before Node 20.11 — passing it unconditionally made Node 18 exit 9 with
// "bad option" and run nothing at all. Probe for it rather than reasoning from
// version numbers, which is how it got shipped broken in the first place.
function supportsTestTimeout() {
  const probe = spawnSync(process.execPath, ['--test-timeout=1', '-e', ''], { stdio: 'ignore' });
  return probe.status === 0;
}
const backstop = supportsTestTimeout() ? ['--test-timeout=60000'] : [];

// Almost every test mkdtemps a scratch board and 40 of 46 files never remove
// it. One run leaks ~347 directories at ~7 inodes each, so a few hundred runs
// exhausted a 1,048,576-inode tmpfs while using barely any disk -- and then
// nothing on the machine could create a file, including this runner.
//
// Cleaning up here rather than in 40 files means a test added tomorrow is
// covered without anyone remembering to. One day is much longer than this
// runner's one-minute per-test backstop and normal CI lifetime, so a
// concurrent run's live boards are never reclaimed.
const STALE_SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;

function sweepScratchBoards({ root, olderThan } = {}) {
  let removed = 0;
  for (const name of readdirSync(root)) {
    // Both families: tests mkdtemp `gw-*`, while preflight and upgrade use
    // `gatewright-*`. A prefix list would rot the moment someone adds a third,
    // so match the project's temp naming rather than enumerating it.
    if (!name.startsWith('gw-') && !name.startsWith('gatewright-')) continue;
    const path = join(root, name);
    try {
      // birthtime is unreliable across filesystems; mtime is set when the
      // directory is created and again as the test writes into it.
      const mtime = statSync(path).mtimeMs;
      if (olderThan !== undefined && mtime >= olderThan) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A board still held open, or removed by someone else, is not this
      // runner's problem and must never fail the suite.
    }
  }
  return removed;
}

function sweep(options) {
  // Never let cleanup change the verdict: a leaked directory is untidy, a
  // test result reported wrongly is worse.
  try {
    const removed = sweepScratchBoards(options);
    if (removed) process.stdout.write(`swept ${removed} scratch board(s) from ${options.root}\n`);
  } catch { /* ignore */ }
}

// Reclaim leaks from interrupted runs before this invocation creates anything.
sweep({ root: tmpdir(), olderThan: Date.now() - STALE_SCRATCH_AGE_MS });
// The child suite gets its own tmp root. That makes the end-of-run sweep
// unambiguously ours: a concurrent `npm test` has a different root, so even
// freshly-created gw-* boards can never be confused with this runner's.
// os.tmpdir() reads TMPDIR on POSIX and TEMP, then TMP, on Windows; setting
// all three moves every test, and every process a test spawns, into runTmp.
const runTmp = mkdtempSync(join(tmpdir(), 'gw-test-run-'));
// Windows env names are case-insensitive, so drop any `Temp`/`tmp` spelling
// first; a duplicate key would leave which one wins up to the OS.
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'];
// T-0123 — nor may the caller's board or identity: a GW_ROOT exported in this
// shell would otherwise receive every fixture item the suite writes. Each
// test file also scrubs these on import, for a bare `node --test`, and so
// does importing the helper here; filtering the child's copy keeps that
// explicit rather than resting on an import's side effect.
const childEnv = Object.fromEntries(Object.entries(withoutCallerState(process.env)).filter(([key]) => !TEMP_VARS.includes(key.toUpperCase())));
for (const key of TEMP_VARS) childEnv[key] = runTmp;
const child = spawn(process.execPath, ['--test', ...backstop, ...process.argv.slice(2), ...files], {
  stdio: 'inherit',
  env: childEnv,
});
let interruptedBy = null;
function interrupt(signal) {
  if (interruptedBy) return;
  interruptedBy = signal;
  // The runner owns the child, so stop it before reclaiming its boards. On
  // POSIX `node --test` passes the signal on to its per-file processes. On
  // Windows child.kill() is TerminateProcess on `node --test` alone, which
  // orphans a hung test file still holding its scratch board, so the whole
  // tree is ended instead. The exit code below is the runner's own either way.
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill(signal);
  } catch { /* the child may already be gone */ }
}
process.once('SIGINT', () => interrupt('SIGINT'));
process.once('SIGTERM', () => interrupt('SIGTERM'));

// This is only for the runner's own cross-platform test. Emitting the signal
// invokes exactly the same handler without relying on CI console semantics.
// It fires once the fixture writes GW_TEST_INTERRUPT_WHEN, not on a timer, so
// a slow CI machine cannot interrupt before the child is actually running.
if (process.env.GW_TEST_INTERRUPT) {
  const ready = process.env.GW_TEST_INTERRUPT_WHEN;
  const poll = setInterval(() => {
    if (ready && !existsSync(ready)) return;
    clearInterval(poll);
    process.emit(process.env.GW_TEST_INTERRUPT);
  }, 25);
  child.once('close', () => clearInterval(poll));
}

const result = await new Promise((resolve) => {
  child.once('error', () => resolve({ status: 1 }));
  child.once('close', (status, signal) => resolve({ status, signal }));
});

// This runs after every child outcome, including an interrupt forwarded above.
sweep({ root: runTmp });
try { rmSync(runTmp, { recursive: true, force: true }); } catch { /* ignore */ }
if (interruptedBy) process.exitCode = interruptedBy === 'SIGINT' ? 130 : 143;
else process.exitCode = result.status ?? 1;
