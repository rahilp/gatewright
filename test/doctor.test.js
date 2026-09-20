import './helpers/isolate-env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { readTemplate } from '../lib/templates.js';
import { PRETOOL_COMMAND, withPretoolHook } from '../lib/commands/hook.js';
import { UsageError } from '../lib/cli/errors.js';
import { compareVersions, configFindings, latestPublishedVersion, run, whichBinary } from '../lib/commands/doctor.js';
import { withGwShim } from './helpers/printed-command.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// A port nothing listens on: the suite must never reach for a real registry,
// and an unreachable one is a documented SKIP rather than a failure.
const OFFLINE_REGISTRY = 'http://127.0.0.1:59999';

const roots = [];
const servers = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  for (const server of servers) server.close();
});

// A board the way gw leaves one: the shipped stages and config, a baselined
// digest, a git checkout around it, both enforcement points installed. Each
// test breaks exactly one thing, so a FAIL always has one cause.
function board({ items = [], config = null, hook = true, agentHook = true, git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-doctor-'));
  roots.push(root);
  const store = createStore(root);
  store.ensure();
  store.writeItems(items);
  writeFileSync(store.paths.stages, readTemplate('stages.json'));
  writeFileSync(store.paths.config, config ? JSON.stringify(config, null, 2) : readTemplate('config.json'));
  // Fixture setup, not a hand edit under test: a real board reaches this state
  // through gw, which baselines as it writes.
  store.rebaselineDigest();
  if (git) {
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
    if (hook) {
      const path = join(root, '.git', 'hooks', 'commit-msg');
      writeFileSync(path, `#!/bin/sh\n${readTemplate('commit-msg.sh')}`);
      chmodSync(path, 0o755);
    }
  }
  if (agentHook) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify(withPretoolHook({}), null, 2)}\n`);
  }
  return { root, store };
}

// git is injected rather than run, so a fixture never needs a real checkout
// and a test never depends on the suite's own repository.
function fakeGit(root, { repo = true, hooksPath = null } = {}) {
  return (argv, cwd) => {
    if (!repo) return { status: 128, stdout: '' };
    if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') return { status: 0, stdout: root };
    if (argv[0] === 'config') return hooksPath ? { status: 0, stdout: hooksPath } : { status: 1, stdout: '' };
    if (argv[0] === 'rev-parse' && argv[1] === '--git-common-dir') return { status: 0, stdout: join(root, '.git') };
    return { status: 1, stdout: '' };
  };
}

// Every outside call doctor makes, answering the way a healthy machine would.
function healthyDeps(root, over = {}) {
  return {
    probe: (command) => ({ ok: true, stdout: command.startsWith('gw') ? PKG.version : 'stub', stderr: '' }),
    latestVersion: async () => ({ version: PKG.version }),
    git: fakeGit(root),
    which: (name) => `/usr/bin/${name}`,
    httpGet: async () => ({ status: 200 }),
    ...over,
  };
}

function ctx(root, flags = {}) {
  let out = '';
  let err = '';
  return {
    flags,
    positionals: [],
    store: null,
    root: null,
    actor: 'human:test',
    env: {},
    cwd: root,
    stdout: { write(text) { out += text; } },
    stderr: { write(text) { err += text; } },
    get out() { return out; },
    get err() { return err; },
  };
}

function statusOf(output, label) {
  const line = output.split('\n').find((candidate) => candidate.includes(`  ${label}`));
  return line ? line.slice(0, 4) : null;
}

function snapshot(dir) {
  const files = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    files[relative(dir, path)] = readFileSync(path).toString('base64');
  }
  return files;
}

async function stubServer(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port };
}

test('a healthy board passes every check that applies and exits 0', async () => {
  const { root } = board();
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 0);
  assert.equal(c.out.match(/^FAIL/gm), null, c.out);
  for (const label of ['gw on PATH', 'newest release', 'git repository', 'board', 'board digest', 'stages.json', 'config.json', 'commit hook', 'agent pre-edit guard']) {
    assert.equal(statusOf(c.out, label), 'PASS', `${label}\n${c.out}`);
  }
  // The three that only apply when switched on say so rather than passing
  // silently: a SKIP a reader can act on is the point.
  assert.match(c.out, /SKIP {2}GitHub CLI .*github\.enabled is false/);
  assert.match(c.out, /SKIP {2}runner provider .*runner\.enabled is false/);
  assert.match(c.out, /SKIP {2}serve .*no --port given/);
  assert.match(c.out, /\n9 checks passed, 3 skipped\. Nothing here is broken\.\n$/);
});

test('doctor writes nothing: not the digest, not a lock, not a line', async () => {
  const { root } = board({ items: [{ id: 'T-1', title: 'one', stage: 'backlog' }] });
  const before = snapshot(join(root, '.gatewright'));
  assert.equal(await run(ctx(root), healthyDeps(root)), 0);
  assert.deepEqual(snapshot(join(root, '.gatewright')), before);
  assert.equal(existsSync(join(root, '.gatewright', '.lock')), false);
});

// The T-0002 rule, from the other side: `gw check` refuses to re-baseline what
// it reports, and a diagnostic that quietly accepted the forgery would launder
// it for the next check.
test('a hand-edited items.jsonl is reported, and reported again, without being re-baselined', async () => {
  const { root, store } = board({ items: [{ id: 'T-1', title: 'one', stage: 'backlog' }] });
  writeFileSync(store.paths.items, `${JSON.stringify({ id: 'T-1', title: 'forged', stage: 'verified' })}\n`);
  const digestBefore = readFileSync(store.paths.digest, 'utf8');

  const first = ctx(root);
  assert.equal(await run(first, healthyDeps(root)), 1);
  assert.equal(statusOf(first.out, 'board digest'), 'FAIL');
  assert.match(first.out, /items\.jsonl changed outside gw since /);
  assert.match(first.out, /fix: run `gw check`.*`gw repair --write --force`/);

  const second = ctx(root);
  assert.equal(await run(second, healthyDeps(root)), 1);
  assert.match(second.out, /items\.jsonl changed outside gw since /);
  assert.equal(readFileSync(store.paths.digest, 'utf8'), digestBefore);
  assert.equal(store.verifyDigest().status, 'modified');
});

test('a board with no digest yet is a skip, not an accusation, and none is written', async () => {
  const { root, store } = board();
  rmSync(store.paths.digest);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 0);
  assert.equal(statusOf(c.out, 'board digest'), 'SKIP');
  assert.equal(existsSync(store.paths.digest), false);
});

test('no board at all is a check that fails, not a command that dies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-doctor-empty-'));
  roots.push(root);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.match(c.out, /^gw doctor — no board found from /);
  assert.equal(statusOf(c.out, 'board '), 'FAIL');
  assert.match(c.out, /fix: create one with `gw init`/);
  // The board is what the rest of the checks read, so they say they had
  // nothing to read rather than inventing a verdict.
  for (const label of ['board digest', 'stages.json', 'config.json', 'agent pre-edit guard']) {
    assert.equal(statusOf(c.out, label), 'SKIP', `${label}\n${c.out}`);
  }
});

test('an unreadable board names gw repair', async () => {
  const { root, store } = board();
  writeFileSync(store.paths.items, 'not json\n');
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.match(c.out, /the board is there but cannot be read: items\.jsonl: line 1 is not valid JSON/);
  assert.match(c.out, /fix: run `gw repair`/);
});

test('a missing commit hook and a missing pre-edit guard each name the command that installs it', async () => {
  const { root } = board({ hook: false, agentHook: false });
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.equal(statusOf(c.out, 'commit hook'), 'FAIL');
  assert.match(c.out, /no gatewright block in .*commit-msg.*\n.*fix: run `gw hook install`/);
  assert.equal(statusOf(c.out, 'agent pre-edit guard'), 'FAIL');
  assert.match(c.out, /fix: run `gw hook install --agent`/);
});

test('a commit hook written by an older gw is reported as drifted, not as installed', async () => {
  const { root } = board();
  const path = join(root, '.git', 'hooks', 'commit-msg');
  writeFileSync(path, readFileSync(path, 'utf8').replace('gw guard --message-file "$1"', 'gw guard "$1"'));
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.equal(statusOf(c.out, 'commit hook'), 'FAIL');
  assert.match(c.out, /is not the one this gw ships/);
  assert.match(c.out, /fix: re-install it with `gw hook install`/);
});

test('an installed commit hook that git cannot execute is reported: git skips it silently', { skip: process.platform === 'win32' ? 'no mode bit on Windows' : false }, async () => {
  const { root } = board();
  chmodSync(join(root, '.git', 'hooks', 'commit-msg'), 0o644);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.match(c.out, /is not executable — git skips a hook it cannot run/);
});

// T-0104 — the bug this check exists for: an older gw installed a bare
// `gw guard --pretool`, which fails CLOSED when the gw on PATH is stale and
// refuses every edit. A stale entry must not read as "installed".
test('a stale pre-edit guard is named as stale, with T-0104 said out loud', async () => {
  const { root } = board({ agentHook: false });
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'gw guard --pretool' }] }] },
  }, null, 2)}\n`);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.equal(statusOf(c.out, 'agent pre-edit guard'), 'FAIL');
  assert.match(c.out, /runs a pre-edit guard this gw did not write/);
  assert.match(c.out, /T-0104/);
  assert.match(c.out, /fix: replace it with `gw hook install --agent`/);
});

test('the pre-edit guard check recognises the command this gw actually installs', async () => {
  const { root } = board({ agentHook: false });
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify({
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo someone-elses-hook' }] },
        { matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: PRETOOL_COMMAND }] },
      ],
    },
  }, null, 2)}\n`);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 0);
  assert.equal(statusOf(c.out, 'agent pre-edit guard'), 'PASS');
});

test('a settings.json that is not JSON is reported as such, since the editor reads no hooks from it', async () => {
  const { root } = board({ agentHook: false });
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), '{ not json\n');
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.match(c.out, /settings\.json is not valid JSON/);
});

test('a board outside a git repository says what stops working, and the hook check stands down', async () => {
  const { root } = board({ git: false, hook: false });
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { git: fakeGit(root, { repo: false }) })), 1);
  assert.equal(statusOf(c.out, 'git repository'), 'FAIL');
  assert.match(c.out, /nowhere to install the commit hook, and `gw guard` has no commit, branch, or range to judge/);
  assert.equal(statusOf(c.out, 'commit hook'), 'SKIP');
  assert.match(c.out, /fix: run `git init` here/);
});

test('core.hooksPath is where the hook is looked for when a repository sets one', async () => {
  const { root } = board({ hook: false });
  const elsewhere = join(root, 'hooks');
  mkdirSync(elsewhere, { recursive: true });
  const path = join(elsewhere, 'commit-msg');
  writeFileSync(path, `#!/bin/sh\n${readTemplate('commit-msg.sh')}`);
  chmodSync(path, 0o755);
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { git: fakeGit(root, { hooksPath: 'hooks' }) })), 0);
  assert.equal(statusOf(c.out, 'commit hook'), 'PASS');
  assert.match(c.out, /installed at hooks[/\\]commit-msg, and current/);
});

test('a stale gw on PATH is a failure even when the gw being asked is current', async () => {
  const { root } = board();
  const c = ctx(root);
  const deps = healthyDeps(root, { probe: (command) => ({ ok: true, stdout: command.startsWith('gw') ? '0.7.0' : 'stub', stderr: '' }) });
  assert.equal(await run(c, deps), 1);
  assert.equal(statusOf(c.out, 'gw on PATH'), 'FAIL');
  assert.match(c.out, /the gw on PATH is 0\.7\.0 .*older than the .* answering this check/);
  assert.match(c.out, /fix: upgrade it with `npm install -g gatewright@latest`/);
});

test('no gw on PATH says why that breaks every fix gw prints', async () => {
  const { root } = board();
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { probe: () => ({ ok: false, stdout: '', stderr: 'not found' }), which: () => null })), 1);
  assert.match(c.out, /no `gw` on this PATH answers `gw --version`/);
  assert.match(c.out, /fix: install it with `npm install -g gatewright`/);
});

test('an unreachable registry is a skip, never a failure: doctor works on a plane', async () => {
  const { root } = board();
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { latestVersion: async () => ({ error: 'ECONNREFUSED' }) })), 0);
  assert.equal(statusOf(c.out, 'newest release'), 'SKIP');
  assert.match(c.out, /the registry did not answer \(ECONNREFUSED\)/);
  assert.match(c.out, /Being offline is never a failure here/);
});

test('a published release newer than this build is reported with the upgrade command', async () => {
  const { root } = board();
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { latestVersion: async () => ({ version: '99.0.0' }) })), 1);
  assert.equal(statusOf(c.out, 'newest release'), 'FAIL');
  assert.match(c.out, /99\.0\.0 is published/);
  assert.match(c.out, /fix: upgrade with `npm install -g gatewright@latest`/);
});

test('GitHub sync is checked only when it is switched on, and separates missing from unauthenticated', async () => {
  const config = { ...JSON.parse(readTemplate('config.json')) };
  config.github = { ...config.github, enabled: true, repo: 'rahilp/gatewright' };

  const missing = board({ config });
  const noGh = ctx(missing.root);
  assert.equal(await run(noGh, healthyDeps(missing.root, {
    probe: (command) => ({ ok: !command.startsWith('gh'), stdout: PKG.version, stderr: '' }),
  })), 1);
  assert.match(noGh.out, /no `gh` on this PATH answers `gh --version`/);
  assert.match(noGh.out, /fix: install the GitHub CLI/);

  const loggedOut = board({ config });
  const noAuth = ctx(loggedOut.root);
  assert.equal(await run(noAuth, healthyDeps(loggedOut.root, {
    probe: (command) => ({ ok: command !== 'gh auth status', stdout: PKG.version, stderr: '' }),
  })), 1);
  assert.match(noAuth.out, /gh is installed .* but not authenticated/);
  assert.match(noAuth.out, /fix: run `gh auth login`/);

  const healthy = board({ config });
  const authed = ctx(healthy.root);
  assert.equal(await run(authed, healthyDeps(healthy.root)), 0);
  assert.match(authed.out, /PASS {2}GitHub CLI .*authenticated, for rahilp\/gatewright/);
});

test('an enabled runner whose provider binary is missing is a failure before any dispatch can fail', async () => {
  const config = JSON.parse(readTemplate('config.json'));
  config.runner = { ...config.runner, enabled: true, provider: 'claude' };
  const { root } = board({ config });
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root, { which: (name) => (name === 'claude' ? null : `/usr/bin/${name}`) })), 1);
  assert.equal(statusOf(c.out, 'runner provider'), 'FAIL');
  assert.match(c.out, /its command `claude` is not on this PATH/);

  const ok = ctx(root);
  assert.equal(await run(ok, healthyDeps(root)), 0);
  assert.match(ok.out, /PASS {2}runner provider .*claude: claude resolves to \/usr\/bin\/claude/);
});

test('a runner pointed at a script in the repository is resolved as a path, not a PATH lookup', async () => {
  const config = JSON.parse(readTemplate('config.json'));
  config.runner = { ...config.runner, enabled: true, provider: 'custom' };
  const { root } = board({ config });
  const missing = ctx(root);
  assert.equal(await run(missing, healthyDeps(root)), 1);
  assert.match(missing.out, /its command `\.\/scripts\/run-agent\.sh` does not exist/);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run-agent.sh'), '#!/bin/sh\n');
  chmodSync(join(root, 'scripts', 'run-agent.sh'), 0o755);
  const present = ctx(root);
  assert.equal(await run(present, healthyDeps(root)), 0);
  assert.equal(statusOf(present.out, 'runner provider'), 'PASS');
});

test('config.json that gw cannot use is reported field by field', async () => {
  const { root } = board({ config: { vocab: { phase: 'P1' }, check: { stale_days: 0 }, github: { enabled: true, repo: null } } });
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.equal(statusOf(c.out, 'config.json'), 'FAIL');
  assert.match(c.out, /vocab\.phase must be a list of strings/);
  assert.match(c.out, /check\.stale_days must be a positive number/);
  assert.match(c.out, /github\.enabled is true but github\.repo names no repository/);
});

test('a stages.json that does not define a usable pipeline is reported before anything reads it', async () => {
  const { root, store } = board();
  writeFileSync(store.paths.stages, JSON.stringify({ stages: [{ id: 'backlog', role: 'not-a-role' }], terminal: ['missing'], extra: [] }));
  const c = ctx(root);
  assert.equal(await run(c, healthyDeps(root)), 1);
  assert.equal(statusOf(c.out, 'stages.json'), 'FAIL');
  assert.match(c.out, /role "not-a-role" is invalid/);

  writeFileSync(store.paths.stages, '{ oops');
  const broken = ctx(root);
  assert.equal(await run(broken, healthyDeps(root)), 1);
  assert.match(broken.out, /stages\.json is not valid JSON/);
});

test('--port probes a serve that is already running and never starts one', async () => {
  const { root } = board();
  const c = ctx(root, { port: '4242' });
  const asked = [];
  assert.equal(await run(c, healthyDeps(root, { httpGet: async (url) => { asked.push(url); return { status: 200 }; } })), 0);
  assert.deepEqual(asked, ['http://127.0.0.1:4242/api/state', 'http://localhost:4242/api/state']);
  assert.match(c.out, /PASS {2}serve on port 4242 .*answers 200 on 127\.0\.0\.1 and on localhost/);
});

test('a port with nothing on it names the command that would start one', async () => {
  const { root } = board();
  const c = ctx(root, { port: '4242' });
  assert.equal(await run(c, healthyDeps(root, { httpGet: async () => ({ error: 'ECONNREFUSED' }) })), 1);
  assert.match(c.out, /nothing serves \/api\/state on port 4242: 127\.0\.0\.1 — no answer \(ECONNREFUSED\); localhost — no answer \(ECONNREFUSED\)/);
  assert.match(c.out, /fix: start it with `gw serve --port 4242`/);
});

// The answer differing by the name the board is asked by is precisely the
// failure a person reports as "the board is broken in my browser".
test('a serve that answers 127.0.0.1 but refuses localhost is reported as the discrepancy it is', async () => {
  const { root } = board();
  const c = ctx(root, { port: '4242' });
  const deps = healthyDeps(root, { httpGet: async (url) => (url.includes('localhost') ? { status: 403 } : { status: 200 }) });
  assert.equal(await run(c, deps), 1);
  assert.equal(statusOf(c.out, 'serve on port 4242'), 'FAIL');
  assert.match(c.out, /127\.0\.0\.1 — HTTP 200; localhost — HTTP 403/);
  assert.match(c.out, /A browser picks the name, so localhost is what a person would actually see/);
});

test('--port refuses a value that is not a port', async () => {
  const { root } = board();
  await assert.rejects(() => run(ctx(root, { port: 'yes' }), healthyDeps(root)), UsageError);
  await assert.rejects(() => run(ctx(root, { port: '70000' }), healthyDeps(root)), UsageError);
});

test('--json carries every check, its status, and the fix, for a program to act on', async () => {
  const { root } = board({ hook: false });
  const c = ctx(root, { json: true });
  assert.equal(await run(c, healthyDeps(root)), 1);
  const report = JSON.parse(c.out);
  assert.equal(report.ok, false);
  assert.equal(report.version, PKG.version);
  assert.equal(report.root, root);
  assert.deepEqual(Object.keys(report).sort(), ['checks', 'ok', 'root', 'summary', 'version']);
  const ids = report.checks.map((check) => check.id);
  assert.deepEqual(ids, ['gw-on-path', 'version', 'git', 'board', 'digest', 'stages', 'config', 'commit-hook', 'pre-edit-guard', 'github-cli', 'runner-provider', 'serve']);
  for (const check of report.checks) {
    assert.deepEqual(Object.keys(check).sort(), ['detail', 'fix', 'id', 'label', 'status']);
    assert.ok(['pass', 'fail', 'skip'].includes(check.status), check.status);
    assert.equal(typeof check.detail, 'string');
    if (check.status === 'fail') assert.equal(typeof check.fix, 'string', `${check.id} must name a fix`);
    else assert.equal(check.fix, null);
  }
  assert.equal(report.summary.fail, report.checks.filter((check) => check.status === 'fail').length);
  assert.equal(report.summary.pass + report.summary.fail + report.summary.skip, report.checks.length);
  // The human block is never mixed into machine output.
  assert.equal(c.out.split('\n').filter(Boolean).length, 1);
});

test('--json says ok on a healthy board and exits 0', async () => {
  const { root } = board();
  const c = ctx(root, { json: true });
  assert.equal(await run(c, healthyDeps(root)), 0);
  assert.equal(JSON.parse(c.out).ok, true);
});

test('compareVersions orders releases and refuses to guess at what is not a version', () => {
  assert.equal(compareVersions('0.13.1', '0.13.2'), -1);
  assert.equal(compareVersions('0.14.0', '0.13.9'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('0.13.2-beta.1', '0.13.2'), 0);
  assert.equal(compareVersions('nonsense', '1.0.0'), null);
});

test('whichBinary finds a command on PATH and leaves a path alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-doctor-path-'));
  roots.push(dir);
  const name = process.platform === 'win32' ? 'thing.CMD' : 'thing';
  writeFileSync(join(dir, name), '');
  assert.equal(whichBinary('thing', { PATH: dir }, process.platform), join(dir, name));
  assert.equal(whichBinary('absent', { PATH: dir }, process.platform), null);
  assert.equal(whichBinary('./scripts/thing', { PATH: dir }, process.platform), null);
});

test('configFindings passes a shipped config and catches the shapes gw cannot read', () => {
  assert.deepEqual(configFindings(JSON.parse(readTemplate('config.json'))), []);
  assert.deepEqual(configFindings([]), ['config.json is not a JSON object']);
  assert.deepEqual(configFindings({ runner: 'claude' }), ['runner is not an object']);
});

// The registry lookup, against a real socket. Its two answers are the two
// the check has to tell apart: a version, and silence.
test('the registry lookup reads a version over the wire and reports unreachable as an error, never a version', async () => {
  const { port } = await stubServer((req, res) => {
    assert.equal(req.url, '/gatewright/latest');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '9.9.9' }));
  });
  assert.deepEqual(await latestPublishedVersion({ npm_config_registry: `http://127.0.0.1:${port}` }), { version: '9.9.9' });

  const refused = await latestPublishedVersion({ npm_config_registry: 'http://127.0.0.1:59999' });
  assert.equal(refused.version, undefined);
  assert.ok(refused.error, 'an unreachable registry must come back as an error, so the check can skip');
});

// The end-to-end pass: a real checkout, a real `gw init`, the real hook
// installer, and the real probes. Everything above injects; this proves the
// defaults agree with the injections. The registry is pointed at a port
// nothing listens on, so the suite never depends on a network — which is
// exactly the SKIP the check promises.
test('gw doctor on a board gw itself set up passes end to end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-doctor-e2e-'));
  roots.push(root);
  const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  assert.equal(initialized.status, 0, `git init failed: ${initialized.stderr}`);

  const result = withGwShim((env) => {
    const shared = { cwd: root, encoding: 'utf8', env: { ...env, npm_config_registry: OFFLINE_REGISTRY } };
    execFileSync(process.execPath, [BIN, 'init', '--yes'], shared);
    execFileSync(process.execPath, [BIN, 'hook', 'install', '--agent'], shared);
    return spawnSync(process.execPath, [BIN, 'doctor'], shared);
  }, process.env);

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout.match(/^FAIL/gm), null, result.stdout);
  assert.match(result.stdout, /PASS {2}gw on PATH/);
  assert.match(result.stdout, /PASS {2}commit hook {2}.*installed at/);
  assert.match(result.stdout, /PASS {2}agent pre-edit guard/);
  assert.match(result.stdout, /SKIP {2}newest release/);
  assert.match(result.stdout, /Nothing here is broken\.\n$/);
});

test('gw doctor exits 1 and reports a broken board end to end, without repairing it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-doctor-e2e-broken-'));
  roots.push(root);
  const env = { ...process.env, npm_config_registry: OFFLINE_REGISTRY };
  execFileSync(process.execPath, [BIN, 'init', '--yes'], { cwd: root, encoding: 'utf8', env });
  const store = createStore(root);
  writeFileSync(store.paths.items, `${JSON.stringify({ id: 'T-1', title: 'hand written', stage: 'backlog' })}\n`);
  const digestBefore = readFileSync(store.paths.digest, 'utf8');

  const result = spawnSync(process.execPath, [BIN, 'doctor'], { cwd: root, encoding: 'utf8', env });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /FAIL {2}board digest .*items\.jsonl changed outside gw since /);
  assert.equal(readFileSync(store.paths.digest, 'utf8'), digestBefore);
  assert.equal(store.verifyDigest().status, 'modified');
});
