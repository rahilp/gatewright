// Enumerate test files in JS rather than relying on a shell glob.
// PowerShell does not expand globs, and `node --test` only learned to expand
// them itself in Node 22 — so `node --test test/*.test.js` runs nothing on
// Windows with Node 18 or 20 and exits 1 having tested precisely zero code.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = 'test';
const files = readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort().map((name) => join(dir, name));
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
// covered without anyone remembering to. Only directories created during THIS
// run are removed, by comparing against the start time, so a concurrent run's
// boards are left alone.
const startedAt = Date.now();
const result = spawnSync(process.execPath, ['--test', ...backstop, ...process.argv.slice(2), ...files], { stdio: 'inherit' });

function sweepScratchBoards() {
  const root = tmpdir();
  let removed = 0;
  for (const name of readdirSync(root)) {
    // Both families: tests mkdtemp `gw-*`, while preflight and upgrade use
    // `gatewright-*`. A prefix list would rot the moment someone adds a third,
    // so match the project's temp naming rather than enumerating it.
    if (!name.startsWith('gw-') && !name.startsWith('gatewright-')) continue;
    const path = join(root, name);
    try {
      // birthtime is unreliable across filesystems; mtime is set when the
      // directory is created and again as the test writes into it, so a board
      // from this run always sorts after the start.
      if (statSync(path).mtimeMs < startedAt) continue;
      rmSync(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A board still held open, or removed by someone else, is not this
      // runner's problem and must never fail the suite.
    }
  }
  return removed;
}

// Never let cleanup change the verdict: a leaked directory is untidy, a test
// result reported wrongly is worse.
try {
  const removed = sweepScratchBoards();
  if (removed && process.env.GW_TEST_SWEEP_QUIET !== '1') console.log(`swept ${removed} scratch board(s) from ${tmpdir()}`);
} catch { /* ignore */ }

process.exit(result.status ?? 1);
