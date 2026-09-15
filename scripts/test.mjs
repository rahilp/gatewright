// Enumerate test files in JS rather than relying on a shell glob.
// PowerShell does not expand globs, and `node --test` only learned to expand
// them itself in Node 22 — so `node --test test/*.test.js` runs nothing on
// Windows with Node 18 or 20 and exits 1 having tested precisely zero code.
import { readdirSync } from 'node:fs';
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

const result = spawnSync(process.execPath, ['--test', ...backstop, ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
