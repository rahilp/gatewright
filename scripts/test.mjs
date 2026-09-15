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

const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
