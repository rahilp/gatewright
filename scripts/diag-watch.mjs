// Temporary diagnostic for the Windows/Node-24 `gw open --watch` abort
// (exit 0xC0000409 with no captured stderr). Runs the watcher with INHERITED
// stdio so a native abort's message reaches the CI log instead of dying in a
// pipe the parent never gets to drain.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const item = (over = {}) => ({
  id: 'P1-01', title: 'Repo scaffold', phase: 'P1', priority: 'P1', gate: 'G0',
  type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '',
  deps: [], evidence: [], notes: '', refs: [], parent: null, created_by: 'human', gh: null,
  created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z', ...over,
});

const root = mkdtempSync(join(tmpdir(), 'gw-diag-'));
const store = createStore(root);
store.ensure();
store.writeItems([item()]);
console.log(`[diag] node ${process.version} on ${process.platform}; root ${root}`);

const child = spawn(process.execPath, ['--trace-uncaught', BIN, 'open', '--watch', '--no-browser'], { cwd: root, stdio: 'inherit' });
child.on('exit', (code, signal) => console.log(`[diag] WATCHER EXITED code=${code} signal=${signal}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);
console.log('[diag] alive after startup:', child.exitCode === null);

console.log('[diag] --- writing a normal change');
store.writeItems([item(), item({ id: 'P1-02', title: 'Watch this board' })]);
await sleep(3000);
console.log('[diag] alive after normal change:', child.exitCode === null);

console.log('[diag] --- writing corrupt JSONL');
writeFileSync(store.paths.items, '{corrupt\n');
await sleep(3000);
console.log('[diag] alive after corrupt write:', child.exitCode === null);

if (child.exitCode === null) child.kill('SIGTERM');
await sleep(1500);
console.log(`[diag] final exitCode=${child.exitCode}`);
