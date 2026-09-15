import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGh } from '../lib/sync/gh.js';

function stub({ stdout = '[]', status = 0 } = {}) {
  const calls = [];
  return { calls, run(argv) { calls.push(argv); return { stdout, status }; } };
}

test('issues translates the §9 list query exactly and parses its fixture', () => {
  const fixture = [{ number: 42, title: 'fixture' }];
  const s = stub({ stdout: JSON.stringify(fixture) });
  const gh = createGh({ run: s.run, repo: 'owner/repo' });
  assert.deepEqual(gh.issues({ since: '2026-09-01T00:00:00Z' }), fixture);
  assert.deepEqual(s.calls, [['issue', 'list', '--repo', 'owner/repo', '--state', 'all', '--search', 'updated:>=2026-09-01T00:00:00Z', '--json', 'number,title,body,labels,milestone,state,updatedAt,url', '--limit', '200']]);
});

test('write methods use only their expected gh argv', () => {
  const s = stub({ stdout: JSON.stringify({ number: 7 }) });
  const gh = createGh({ run: s.run, repo: 'owner/repo' });
  gh.comment(7, 'moved'); gh.close(7); gh.editLabels(7, { add: ['agent/go'], remove: ['stale'] }); gh.createIssue({ title: 'child', body: 'scope' });
  assert.deepEqual(s.calls, [
    ['issue', 'comment', '7', '--repo', 'owner/repo', '--body', 'moved'],
    ['issue', 'close', '7', '--repo', 'owner/repo'],
    ['issue', 'edit', '7', '--repo', 'owner/repo', '--add-label', 'agent/go', '--remove-label', 'stale'],
    ['api', '--method', 'POST', 'repos/owner/repo/issues', '--raw-field', 'title=child', '--raw-field', 'body=scope'],
  ]);
});

test('dry run prints writes and never executes them, while reads still execute', () => {
  const s = stub({ stdout: '[]' }); const printed = [];
  const original = console.log; console.log = (line) => printed.push(line);
  try {
    const gh = createGh({ run: s.run, dryRun: true, repo: 'owner/repo' });
    gh.comment(7, 'moved'); gh.close(7); gh.editLabels(7, { remove: ['agent/go'] }); gh.createIssue({ title: 'child', body: 'scope' }); gh.issues();
  } finally { console.log = original; }
  assert.equal(s.calls.length, 1);
  assert.match(printed.join('\n'), /gh issue comment 7/);
  assert.match(printed.join('\n'), /gh api --method POST/);
});

test('missing gh and unauthenticated gh have distinct actionable errors', () => {
  assert.throws(() => createGh({ run() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }, repo: 'o/r' }).authStatus(), /not installed.*gh auth login/i);
  assert.throws(() => createGh({ run: () => ({ stdout: '', status: 1 }), repo: 'o/r' }).authStatus(), /not authenticated.*gh auth login/i);
});

test('a timed-out gh call is reported as a network/slowness failure, not misdiagnosed as missing or unauthenticated', () => {
  const timeout = () => { const error = new Error('etimedout'); error.code = 'ETIMEDOUT'; throw error; };
  assert.throws(() => createGh({ run: timeout, repo: 'o/r' }).authStatus(), /did not respond.*retry/is);
  assert.throws(() => createGh({ run: timeout, repo: 'o/r' }).issues(), /did not respond.*retry/is);
  // Neither of the other two diagnoses leaks through: a timeout is not "not
  // installed" (gh clearly ran) and not "not authenticated" (auth was never
  // reached) — sending someone to `gh auth login` for a hung network call
  // sends them chasing the wrong thing.
  assert.throws(() => createGh({ run: timeout, repo: 'o/r' }).authStatus(), (error) => !/not installed|not authenticated/i.test(error.message));
});

// The two tests above prove the *classification* is right, using the same
// injected-stub style as the rest of this file. This one proves the real
// wiring: that createGh's default `run` actually threads timeoutMs into
// execFileSync's own `timeout` option against a real (fake) `gh` on PATH, so
// a genuinely wedged CLI is caught rather than assumed bounded. No real gh,
// no network — just a slow local script standing in for one.
test('createGh\'s default run really bounds a wedged real gh process, not just the injected-stub path', async () => {
  const traps = mkdtempSync(join(tmpdir(), 'gw-gh-timeout-'));
  const fakeGh = join(traps, 'gh');
  writeFileSync(fakeGh, '#!/bin/sh\nsleep 5\n');
  chmodSync(fakeGh, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${traps}:${priorPath}`;
  try {
    const gh = createGh({ repo: 'o/r', timeoutMs: 200 });
    const started = Date.now();
    assert.throws(() => gh.authStatus(), /did not respond/i);
    assert.ok(Date.now() - started < 4000, 'execFileSync must have actually killed the wedged process near timeoutMs, not waited out its real 5s sleep');
  } finally { process.env.PATH = priorPath; rmSync(traps, { recursive: true, force: true }); }
});
