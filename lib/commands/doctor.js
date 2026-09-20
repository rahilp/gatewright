// doctor — one command that turns "it doesn't work" into a reportable fact.
//
// Every check answers in the same shape: what was looked at, what was found,
// and the exact command that fixes it. Three outcomes only — PASS, FAIL, SKIP
// — because a reader scanning for what to do next should not have to grade a
// severity. A SKIP is never a failure: it means the check does not apply here
// (GitHub sync is off, the registry is unreachable), and doctor must work on a
// plane.
//
// Nothing here writes. A diagnostic that repairs what it finds cannot be run
// twice and believed, so the digest is read ONLY (re-baselining belongs to
// `gw check` and `gw repair --write --force`), no board lock is taken, and the
// serve probe never starts a server.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join, relative, resolve } from 'node:path';
import { UsageError } from '../cli/errors.js';
import { findRoot } from '../cli/root.js';
import { createStore } from '../store.js';
import { readConfig, readStages } from '../config.js';
import { validateStages } from '../stages.js';
import { readTemplate } from '../templates.js';
import { PRETOOL_COMMAND } from './hook.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));

// Bounded, and short. Every one of these is a call into something that can
// hang — a network, a wedged server, a `gh` waiting on a device-auth prompt —
// and a diagnostic that hangs is the failure it was run to explain.
const REGISTRY_TIMEOUT_MS = 2500;
const SERVE_TIMEOUT_MS = 2000;
const PROBE_TIMEOUT_MS = 10_000;

const HOOK_START = '# gatewright:start';
const HOOK_END = '# gatewright:end';
// The substring every gatewright PreToolUse entry contains, current or not.
// hook.js installs by replacing on this match, so doctor recognises a stale
// entry the same way.
const PRETOOL = 'gw guard --pretool';
const CLAUDE_SETTINGS = join('.claude', 'settings.json');
const REGISTRY = 'https://registry.npmjs.org';

export const spec = {
  summary: 'check that everything gw needs is installed, current, and readable',
  flags: { json: { type: 'boolean' }, port: { type: 'string' } },
  positionals: [],
  // A board that is missing or unreadable is the single most likely thing to
  // be wrong, so doctor must run without one and report it as a check rather
  // than dying at the router with the same message every other command gives.
  needsRoot: false,
};

function parseVersion(value) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// -1 when a is older, 1 when a is newer, 0 when they match, null when either
// side is not a version at all (a shim that prints a banner, a registry that
// answered with something unexpected). A null must never be read as "equal":
// callers treat it as "cannot tell" and skip.
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

// PATH resolution without a dependency and without running anything: doctor
// reports WHERE a binary is, and `gw --version` on a stale CLI is the one
// thing we must not need before we can say it is stale.
export function whichBinary(name, env = process.env, platform = process.platform) {
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const search = env.PATH ?? env.Path ?? '';
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of search.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

// Fixed literals only, never user input: shell:true is what lets cmd.exe
// resolve npm's gw.cmd/gh.cmd shims, exactly as lib/commands/hook.js does.
function probeCommand(command, env) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8', env, timeout: PROBE_TIMEOUT_MS });
  return { ok: result.status === 0, stdout: `${result.stdout ?? ''}`.trim(), stderr: `${result.stderr ?? ''}`.trim() };
}

function defaultGit(argv, cwd) {
  const result = spawnSync('git', argv, { cwd, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return { status: result.status ?? 1, stdout: `${result.stdout ?? ''}`.trim() };
}

// Offline is not an error state. Every failure mode of this call — no network,
// a proxy, a private registry that does not carry the package, a 500 — comes
// back as { error } and becomes a SKIP. npm_config_registry is honoured
// because someone on a private registry is asking about the gw they can
// actually install.
export async function latestPublishedVersion(env = process.env, { timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const base = String(env.npm_config_registry || REGISTRY).replace(/\/+$/, '');
  try {
    const response = await fetch(`${base}/${PKG.name}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { error: `the registry answered ${response.status}` };
    const body = await response.json();
    if (typeof body?.version !== 'string') return { error: 'the registry answered without a version' };
    return { version: body.version };
  } catch (error) {
    return { error: error?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : (error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'unreachable') };
  }
}

async function defaultHttpGet(url, { timeoutMs = SERVE_TIMEOUT_MS } = {}) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { status: response.status };
  } catch (error) {
    return { error: error?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000}s` : (error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'unreachable') };
  }
}

// The same two places hook.js installs into, resolved the same way: an
// explicit core.hooksPath wins, otherwise the common git dir's hooks/.
function hooksDir(git, cwd) {
  // resolve(), never join(): git answers --git-common-dir with a relative
  // path in an ordinary checkout and an absolute one in a worktree, and
  // joining the absolute form onto cwd invents a directory that does not
  // exist — which reads as "no hook installed" on a repository that has one.
  const configured = git(['config', '--get', 'core.hooksPath'], cwd);
  if (configured.status === 0 && configured.stdout) return resolve(cwd, configured.stdout);
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  if (common.status !== 0 || !common.stdout) return null;
  return join(resolve(cwd, common.stdout), 'hooks');
}

function gatewrightBlock(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith(HOOK_START));
  const end = lines.findIndex((line) => line.startsWith(HOOK_END));
  if (start === -1 || end === -1 || start > end) return null;
  return lines.slice(start, end + 1).join('\n');
}

function pretoolCommands(settings) {
  const entries = Array.isArray(settings?.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  return entries.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []))
    .map((hook) => String(hook?.command ?? ''))
    .filter((command) => command.includes(PRETOOL));
}

// Deliberately shallow. The deep rules already have owners — validateStages
// for the pipeline, vocabDrift for the vocabulary — and doctor's job is to
// catch the config that stops gw working at all, not to re-litigate policy.
export function configFindings(config) {
  const findings = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['config.json is not a JSON object'];
  const vocab = config.vocab;
  if (vocab !== undefined) {
    if (typeof vocab !== 'object' || vocab === null || Array.isArray(vocab)) findings.push('vocab is not an object');
    else {
      for (const [field, values] of Object.entries(vocab)) {
        if (!Array.isArray(values) || !values.every((value) => typeof value === 'string')) {
          findings.push(`vocab.${field} must be a list of strings`);
        }
      }
    }
  }
  const staleDays = config.check?.stale_days;
  if (staleDays !== undefined && (typeof staleDays !== 'number' || !Number.isFinite(staleDays) || staleDays <= 0)) {
    findings.push('check.stale_days must be a positive number');
  }
  if (config.github?.enabled && !config.github.repo) findings.push('github.enabled is true but github.repo names no repository');
  for (const [key, block] of [['github', config.github], ['runner', config.runner], ['memory', config.memory]]) {
    if (block !== undefined && (typeof block !== 'object' || block === null || Array.isArray(block))) findings.push(`${key} is not an object`);
  }
  return findings;
}

export async function run(ctx, deps = {}) {
  const {
    probe = (command) => probeCommand(command, ctx.env),
    latestVersion = () => latestPublishedVersion(ctx.env),
    git = defaultGit,
    which = whichBinary,
    httpGet = defaultHttpGet,
  } = deps;

  const port = parsePort(ctx.flags.port);
  const checks = [];
  const add = (id, label, status, detail, fix = null) => { checks.push({ id, label, status, detail, fix }); };
  const pass = (id, label, detail) => add(id, label, 'pass', detail);
  const fail = (id, label, detail, fix) => add(id, label, 'fail', detail, fix);
  const skip = (id, label, detail) => add(id, label, 'skip', detail);

  // --- the tool itself -----------------------------------------------------
  const gwPath = which('gw', ctx.env);
  const gwProbe = probe('gw --version');
  const gwVersion = gwProbe.ok ? gwProbe.stdout.split('\n').pop().trim() : null;
  if (!gwProbe.ok) {
    fail('gw-on-path', 'gw on PATH', 'no `gw` on this PATH answers `gw --version`. Every fix gw prints starts with `gw`, and the commit and pre-edit hooks call it by name, so none of them can run.', 'install it with `npm install -g gatewright`, or fix your PATH');
  } else if (compareVersions(gwVersion, PKG.version) === -1) {
    fail('gw-on-path', 'gw on PATH', `the gw on PATH is ${gwVersion}${gwPath ? ` (${gwPath})` : ''}, older than the ${PKG.version} answering this check. The hooks call the one on PATH, not this one.`, 'upgrade it with `npm install -g gatewright@latest`');
  } else {
    const same = compareVersions(gwVersion, PKG.version) === 0;
    pass('gw-on-path', 'gw on PATH', `gw ${gwVersion}${gwPath ? ` at ${gwPath}` : ''}${same ? ', the build answering this check' : `, newer than the ${PKG.version} answering this check`}`);
  }

  const latest = await latestVersion();
  if (!latest?.version) {
    skip('version', 'newest release', `the registry did not answer (${latest?.error ?? 'unreachable'}), so gw cannot tell whether a newer release exists. Being offline is never a failure here.`);
  } else {
    const order = compareVersions(PKG.version, latest.version);
    if (order === -1) {
      fail('version', 'newest release', `this gw is ${PKG.version}; ${latest.version} is published. A command or a fix you were told to run may simply not exist in this build.`, 'upgrade with `npm install -g gatewright@latest`');
    } else if (order === 1) {
      pass('version', 'newest release', `${PKG.version}, ahead of the newest published release (${latest.version})`);
    } else {
      pass('version', 'newest release', `${PKG.version} is the newest published release`);
    }
  }

  // --- where it is running -------------------------------------------------
  let root = null;
  let rootError = null;
  try {
    root = findRoot(ctx.cwd, ctx.env, { stderr: ctx.stderr });
  } catch (error) {
    rootError = error;
  }
  const gitCwd = root ?? ctx.cwd;
  const gitTop = git(['rev-parse', '--show-toplevel'], gitCwd);
  const inGitRepo = gitTop.status === 0 && Boolean(gitTop.stdout);
  if (inGitRepo) pass('git', 'git repository', `${gitCwd} is inside ${gitTop.stdout}`);
  else fail('git', 'git repository', `${gitCwd} is not inside a git repository. The board still works, but there is nowhere to install the commit hook, and \`gw guard\` has no commit, branch, or range to judge — so nothing enforces what the board says.`, 'run `git init` here, or run gw from the checkout the work lives in');

  // --- the board -----------------------------------------------------------
  let store = null;
  let items = null;
  if (rootError) {
    // A wrong GW_ROOT already carries its own instruction; `gw init` would be
    // the wrong advice for it, and wrong advice is how a doctor loses trust.
    fail('board', 'board', rootError.message, /GW_ROOT/.test(rootError.message) ? 'point GW_ROOT at a project root that contains .gatewright/, or unset it' : 'create one with `gw init`');
  } else {
    store = createStore(root);
    try {
      items = store.readItems();
      pass('board', 'board', `${items.length} ${items.length === 1 ? 'item' : 'items'} in ${join(relative(ctx.cwd, root) || '.', '.gatewright')}`);
    } catch (error) {
      fail('board', 'board', `the board is there but cannot be read: ${error.message}`, 'run `gw repair` to see the damage, then `gw repair --write` to quarantine the bad lines — or restore the file from git');
    }
  }

  if (!store) {
    skip('digest', 'board digest', 'no board to compare against');
    skip('stages', 'stages.json', 'no board to read');
    skip('config', 'config.json', 'no board to read');
  } else {
    const digest = store.verifyDigest();
    if (digest.status === 'clean') {
      pass('digest', 'board digest', 'items.jsonl, stages.json and config.json are byte-for-byte what gw last wrote');
    } else if (digest.status === 'unknown') {
      skip('digest', 'board digest', 'no digest has been recorded yet, so there is nothing to compare against. The next gw write baselines it; doctor never writes one.');
    } else {
      fail('digest', 'board digest', `${digest.files.join(', ')} changed outside gw since ${digest.since}. Whatever is in there was not written by gw, so no rule was applied to it.`, 'run `gw check` to see what it says now, then `gw repair --write --force` to accept it deliberately — or restore the file from git');
    }

    let stages = null;
    try {
      stages = readStages(store);
      const findings = validateStages(stages);
      if (findings.length) fail('stages', 'stages.json', `the pipeline is not usable: ${findings.join('; ')}`, 'fix stages.json by hand, then run `gw check`');
      else pass('stages', 'stages.json', `${(stages.stages ?? []).length} pipeline stages, ${(stages.extra ?? []).length} off-pipeline`);
    } catch (error) {
      fail('stages', 'stages.json', error.message, 'fix the JSON by hand, or restore stages.json from git');
    }

    try {
      const config = readConfig(store);
      const findings = configFindings(config);
      if (findings.length) fail('config', 'config.json', findings.join('; '), 'fix it with `gw config <key> <value>`, or edit config.json by hand');
      else pass('config', 'config.json', 'parses, and every setting gw reads has the shape it expects');
    } catch (error) {
      fail('config', 'config.json', error.message, 'fix the JSON by hand, or restore config.json from git');
    }
  }

  // --- what enforces the board ---------------------------------------------
  if (!inGitRepo) {
    skip('commit-hook', 'commit hook', 'not a git repository, so there is nowhere for a commit hook to live');
  } else {
    const dir = hooksDir(git, gitCwd);
    const hookPath = dir ? join(dir, 'commit-msg') : null;
    const existing = hookPath && existsSync(hookPath) ? readFileSync(hookPath, 'utf8') : null;
    const block = existing ? gatewrightBlock(existing) : null;
    const where = hookPath ? (relative(gitCwd, hookPath) || hookPath) : 'the hooks directory';
    if (!block) {
      fail('commit-hook', 'commit hook', `no gatewright block in ${where}, so a commit that names, claims, or branches on nothing still lands.`, 'run `gw hook install`');
    } else if (block !== gatewrightBlock(readTemplate('commit-msg.sh'))) {
      fail('commit-hook', 'commit hook', `the block in ${where} is not the one this gw ships: it was written by another version and has drifted.`, 're-install it with `gw hook install`');
    } else if (process.platform !== 'win32' && !isExecutable(hookPath)) {
      fail('commit-hook', 'commit hook', `${where} is installed and current, but is not executable — git skips a hook it cannot run, and says nothing about it.`, 'run `gw hook install` (it sets the mode bit), or `chmod +x` the file');
    } else {
      pass('commit-hook', 'commit hook', `installed at ${where}, and current`);
    }
  }

  if (!root) {
    skip('pre-edit-guard', 'agent pre-edit guard', 'no board here, so there is no project to guard');
  } else {
    const settingsPath = join(root, CLAUDE_SETTINGS);
    let settings = null;
    let unreadable = null;
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch (error) { unreadable = error; }
    }
    const commands = settings ? pretoolCommands(settings) : [];
    if (unreadable) {
      fail('pre-edit-guard', 'agent pre-edit guard', `${CLAUDE_SETTINGS} is not valid JSON, so the editor reads no hooks from it at all.`, 'fix the JSON by hand, then run `gw hook install --agent`');
    } else if (!commands.length) {
      fail('pre-edit-guard', 'agent pre-edit guard', `nothing in ${CLAUDE_SETTINGS} runs \`gw guard\` before an edit, so an agent can edit any file without an item on the board accounting for it.`, 'run `gw hook install --agent`');
    } else if (!commands.includes(PRETOOL_COMMAND)) {
      fail('pre-edit-guard', 'agent pre-edit guard', `${CLAUDE_SETTINGS} runs a pre-edit guard this gw did not write — an older one installed it. That is T-0104: the old command fails CLOSED when the gw on PATH is stale, so every edit is refused with "unknown command 'guard'", on the board or not, until it is replaced.`, 'replace it with `gw hook install --agent`');
    } else {
      pass('pre-edit-guard', 'agent pre-edit guard', `current, in ${CLAUDE_SETTINGS}`);
    }
  }

  // --- what gw only needs when it is switched on ---------------------------
  const config = store ? safeConfig(store) : null;
  if (!config?.github?.enabled) {
    skip('github-cli', 'GitHub CLI', 'github.enabled is false, so gw never calls gh');
  } else {
    const ghPath = which('gh', ctx.env);
    if (!probe('gh --version').ok) {
      fail('github-cli', 'GitHub CLI', 'github.enabled is true, but no `gh` on this PATH answers `gh --version`, so `gw sync` and every GitHub write will fail.', 'install the GitHub CLI (https://cli.github.com), then run `gh auth login`');
    } else if (!probe('gh auth status').ok) {
      fail('github-cli', 'GitHub CLI', `gh is installed${ghPath ? ` at ${ghPath}` : ''} but not authenticated, so every call to GitHub is refused.`, 'run `gh auth login`');
    } else {
      pass('github-cli', 'GitHub CLI', `installed${ghPath ? ` at ${ghPath}` : ''} and authenticated, for ${config.github.repo}`);
    }
  }

  if (!config?.runner?.enabled) {
    skip('runner-provider', 'runner provider', 'runner.enabled is false, so gw never launches an agent');
  } else {
    const name = config.runner.provider;
    const provider = config.runner.providers?.[name];
    const argv = provider?.cmd;
    if (!name) {
      fail('runner-provider', 'runner provider', 'the runner is enabled but runner.provider names no provider.', 'set one with `gw config runner.provider <name>`');
    } else if (!provider) {
      fail('runner-provider', 'runner provider', `the runner is enabled and set to '${name}', but runner.providers.${name} is not configured, so the scheduler has no command to run.`, `add runner.providers.${name}.cmd to .gatewright/config.json, or pick a configured provider with \`gw config runner.provider <name>\``);
    } else if (!Array.isArray(argv) || !argv.length || !argv.every((part) => typeof part === 'string')) {
      fail('runner-provider', 'runner provider', `runner.providers.${name}.cmd must be a non-empty list of strings.`, 'fix it in .gatewright/config.json');
    } else {
      const binary = argv[0];
      const relativePath = binary.includes('/') || binary.includes('\\') ? join(root, binary) : null;
      const resolved = relativePath ?? which(binary, ctx.env);
      if (relativePath ? !existsSync(relativePath) : !resolved) {
        fail('runner-provider', 'runner provider', `the runner is enabled, but its command \`${binary}\` ${relativePath ? 'does not exist' : 'is not on this PATH'}: every dispatch will fail the moment the scheduler tries to start it.`, `install ${binary}, or point runner.providers.${name}.cmd at a command that exists`);
      } else if (relativePath && process.platform !== 'win32' && !isExecutable(relativePath)) {
        fail('runner-provider', 'runner provider', `${binary} exists but is not executable, so the scheduler cannot start it.`, `run \`chmod +x ${binary}\``);
      } else {
        pass('runner-provider', 'runner provider', `${name}: ${binary} resolves to ${resolved}`);
      }
    }
  }

  // --- serve, only when asked ----------------------------------------------
  if (port === null) {
    skip('serve', 'serve', 'no --port given, so doctor did not look for a running board. It never starts one: pass `--port <p>` to probe a serve you started yourself.');
  } else {
    const results = [];
    for (const host of ['127.0.0.1', 'localhost']) {
      results.push({ host, ...(await httpGet(`http://${host}:${port}/api/state`)) });
    }
    const describe = (result) => (result.error ? `no answer (${result.error})` : `HTTP ${result.status}`);
    const answered = results.filter((result) => result.status === 200);
    if (answered.length === results.length) {
      pass('serve', `serve on port ${port}`, `/api/state answers 200 on 127.0.0.1 and on localhost`);
    } else if (!answered.length) {
      fail('serve', `serve on port ${port}`, `nothing serves /api/state on port ${port}: ${results.map((result) => `${result.host} — ${describe(result)}`).join('; ')}.`, `start it with \`gw serve --port ${port}\`, or pass the port it is actually on`);
    } else {
      const broken = results.filter((result) => result.status !== 200);
      fail('serve', `serve on port ${port}`, `the same board answers differently depending on the name it is asked by: ${results.map((result) => `${result.host} — ${describe(result)}`).join('; ')}. A browser picks the name, so ${broken.map((result) => result.host).join(' and ')} is what a person would actually see.`, `report it with this line; until it is fixed, open the board on ${answered[0].host}:${port}`);
    }
  }

  const summary = {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skip: checks.filter((check) => check.status === 'skip').length,
  };
  const ok = summary.fail === 0;

  if (ctx.flags.json) {
    ctx.stdout.write(`${JSON.stringify({ ok, version: PKG.version, root, checks, summary })}\n`);
    return ok ? 0 : 1;
  }

  ctx.stdout.write(`gw doctor — ${root ? `board at ${root}` : `no board found from ${ctx.cwd}`}\n\n`);
  const width = Math.max(...checks.map((check) => check.label.length));
  for (const check of checks) {
    ctx.stdout.write(`${check.status.toUpperCase()}  ${check.label.padEnd(width)}  ${check.detail}\n`);
    if (check.status === 'fail' && check.fix) ctx.stdout.write(`${' '.repeat(6)}${' '.repeat(width)}  fix: ${check.fix}\n`);
  }
  const skipped = summary.skip ? `, ${summary.skip} skipped` : '';
  ctx.stdout.write(ok
    ? `\n${summary.pass} ${summary.pass === 1 ? 'check' : 'checks'} passed${skipped}. Nothing here is broken.\n`
    : `\n${summary.fail} of ${checks.length} checks failed${skipped}. Each FAIL line names the command that fixes it.\n`);
  return ok ? 0 : 1;
}

function parsePort(value) {
  if (value === undefined) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`--port needs a port number between 1 and 65535, not ${JSON.stringify(String(value))}.`);
  }
  return port;
}

function isExecutable(path) {
  try { return Boolean(statSync(path).mode & 0o111); } catch { return false; }
}

// The config has already been reported on by its own check; a second failure
// here would say the same thing twice, so an unreadable config simply means
// the switched-on-only checks have nothing to read.
function safeConfig(store) {
  try { return readConfig(store); } catch { return null; }
}
