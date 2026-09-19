// hook — installs the two places `gw guard` can stand: the local commit-msg
// hook, and a CI workflow. Nothing here decides anything; both installations
// are thin routes to `gw guard`, so the rule lives in one module and a hook
// that drifts out of date still asks the current CLI.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { IOError, UsageError } from '../cli/errors.js';
import { createGit } from '../git.js';
import { readTemplate } from '../templates.js';

const PKG = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const START = '# gatewright:start';
const END = '# gatewright:end';
const SHEBANG = '#!/bin/sh';
const ACTIONS = ['install', 'status', 'uninstall'];
const WORKFLOW = join('.github', 'workflows', 'gatewright.yml');
const CLAUDE_SETTINGS = join('.claude', 'settings.json');
const PRETOOL = 'gw guard --pretool';
// Claude Code uses sh on macOS/Linux and either Git Bash or PowerShell on
// Windows. This command has no shell syntax, so one settings file works in
// every supported shell. Node is already required by Gatewright and Claude
// Code; it runs the same two-step probe as the commit-msg hook and consumes a
// stale gw's usage exit 2 before it can be mistaken for a PreToolUse refusal.
// The inner commands are fixed literals, so shell:true is safe and lets cmd.exe
// resolve npm's gw.cmd/npx.cmd shims on native Windows. `inherit` carries the
// Claude hook JSON from this Node process through the inner shell to gw.
// Quoting: the JS body uses only single quotes, and contains no ", $, `, \,
// %, ! or ^, so the one double-quoted argument reaches node unchanged under
// sh, Git Bash, PowerShell and cmd.exe, and JSON only escapes its two outer
// quotes. The leading comment keeps PRETOOL in the command so install and
// uninstall still recognise (and replace) both old and new entries.
export const PRETOOL_COMMAND = "node -e \"/* gw guard --pretool */const{spawnSync}=require('node:child_process');const candidates=[['gw guard --help','gw guard --pretool'],['npx --no-install gw guard --help','npx --no-install gw guard --pretool']];for(const[probe,guard]of candidates){if(spawnSync(probe,{shell:true,stdio:'ignore'}).status===0){const result=spawnSync(guard,{shell:true,stdio:'inherit'});process.exit(result.status===null?0:result.status)}}\"";

// T-0067 — the installed hook probes for a guard-capable gw before it fires,
// and steps aside when the probe fails: a missing or stale tool must never
// make a repository uncommittable. But it stepped aside SILENTLY — on a
// machine whose `gw` predates `gw guard`, install announced the hook and
// status reported it installed, and every commit passed unguarded while both
// claimed otherwise. So install and status run the same probe the hook runs
// (both of its branches: the gw on PATH, then the npx fallback) and say so
// loudly when it fails. Injected as `probe` in tests, exactly like git.
export const GUARD_WARNING = 'gw: WARNING — the guard probe failed: the gw this hook would call does not answer `gw guard --help`. '
  + 'The hook is installed but will not fire — until a guard-capable gw is on PATH, every edit and commit passes unguarded. '
  + 'Upgrade the gw on your PATH (`npm install -g gatewright`) or fix your PATH, then re-run `gw hook status`. '
  + 'The probe is rerun by `gw hook status`, so this warning clears itself when the tool is fixed.';

export function defaultProbe(env = process.env) {
  // The identical invocations PRETOOL_COMMAND probes with, in the same order.
  // These are fixed literals (not user input), so shell:true has no
  // interpolation surface and allows cmd.exe to resolve gw.cmd/npx.cmd.
  const succeeds = (command) => spawnSync(command, { shell: true, stdio: 'ignore', env }).status === 0;
  return succeeds('gw guard --help')
    || succeeds('npx --no-install gw guard --help');
}

export const spec = {
  summary: 'install or remove the commit-msg hook and CI check that enforce the board',
  flags: { ci: { type: 'boolean' }, agent: { type: 'boolean' }, force: { type: 'boolean' } },
  positionals: [{ name: 'action', required: false }],
};

function hooksDir(git, cwd) {
  let configured = '';
  try { configured = git.run(['config', '--get', 'core.hooksPath'], { cwd }).stdout.trim(); } catch { configured = ''; }
  if (configured) return { dir: resolve(cwd, configured), viaConfig: true };
  const common = git.run(['rev-parse', '--git-common-dir'], { cwd }).stdout.trim();
  return { dir: join(resolve(cwd, common), 'hooks'), viaConfig: false };
}

// Fenced like the AGENTS.md block, and for the same reason: a repository may
// already have a commit-msg hook, and ours has to live inside it without
// claiming the file or being impossible to take back out.
function spliceBlock(existing, block) {
  const lines = existing.split('\n');
  const start = lines.findIndex((line) => line.startsWith(START));
  const end = lines.findIndex((line) => line.startsWith(END));
  if (start === -1 && end === -1) {
    const body = existing.replace(/\s+$/, '');
    if (!body) return `${SHEBANG}\n${block}`;
    return `${body}\n\n${block}`;
  }
  if (start === -1 || end === -1 || start > end) {
    throw new UsageError('the commit-msg hook has an unpaired gatewright marker; fix the file by hand, then re-run `gw hook install`.');
  }
  return [...lines.slice(0, start), block.replace(/\n$/, ''), ...lines.slice(end + 1)].join('\n');
}

function removeBlock(existing) {
  const lines = existing.split('\n');
  const start = lines.findIndex((line) => line.startsWith(START));
  const end = lines.findIndex((line) => line.startsWith(END));
  if (start === -1 || end === -1 || start > end) return null;
  const rest = [...lines.slice(0, start), ...lines.slice(end + 1)];
  return rest.join('\n').replace(/\n{3,}/g, '\n\n');
}

function hookInstalled(path) {
  return existsSync(path) && readFileSync(path, 'utf8').includes(START);
}

function workflowText() {
  return readTemplate('workflow.yml').replaceAll('__VERSION__', PKG.version);
}

function installHook({ path, stdout, root }) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const updated = spliceBlock(existing, readTemplate('commit-msg.sh'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, updated.endsWith('\n') ? updated : `${updated}\n`);
  // Git skips a hook it cannot execute, and says nothing about it. A guard
  // that silently does not run is worse than no guard.
  try { chmodSync(path, 0o755); } catch { /* filesystems without a mode bit */ }
  const where = relative(root, path) || path;
  stdout.write(existing.includes(START)
    ? `gw: refreshed the commit-msg hook at ${where}\n`
    : existing
      ? `gw: added the gatewright block to the existing commit-msg hook at ${where}\n`
      : `gw: installed the commit-msg hook at ${where}\n`);
}

// The agent-side gate. Claude Code's plugin (adapters/claude-code) ships the
// same hook; this writes it straight into the project settings for people who
// have not installed the plugin, because a gate nobody turns on gates nothing.
// The file belongs to the project, not to gw, so every other key -- and every
// other hook -- is preserved, and our own entry is matched by its command so
// re-running replaces it instead of stacking duplicates.
export function withPretoolHook(settings) {
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const existing = Array.isArray(next.hooks.PreToolUse) ? next.hooks.PreToolUse : [];
  const kept = existing.flatMap((entry) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    const remaining = hooks.filter((hook) => !String(hook?.command ?? '').includes(PRETOOL));
    // Preserve a user's other handler when it shares a matcher group with an
    // old or current Gatewright handler.
    return remaining.length ? [{ ...entry, hooks: remaining }] : [];
  });
  next.hooks.PreToolUse = [...kept, {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [{ type: 'command', command: PRETOOL_COMMAND }],
  }];
  return next;
}

export function withoutPretoolHook(settings) {
  const entries = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const kept = entries.flatMap((entry) => {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    const remaining = hooks.filter((hook) => !String(hook?.command ?? '').includes(PRETOOL));
    return remaining.length ? [{ ...entry, hooks: remaining }] : [];
  });
  const hooks = { ...(settings.hooks ?? {}) };
  if (kept.length) hooks.PreToolUse = kept; else delete hooks.PreToolUse;
  const next = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete next.hooks;
  return next;
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new UsageError(`${CLAUDE_SETTINGS} is not valid JSON; fix it by hand, then re-run \`gw hook install --agent\`.`);
  }
}

function installAgentHook({ root, stdout }) {
  const path = join(root, CLAUDE_SETTINGS);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(withPretoolHook(readSettings(path)), null, 2)}\n`);
  stdout.write(`gw: edits are now gated before they happen — wrote the PreToolUse guard to ${CLAUDE_SETTINGS}\n`);
}

function uninstallAgentHook({ root, stdout }) {
  const path = join(root, CLAUDE_SETTINGS);
  if (!existsSync(path)) return;
  const stripped = withoutPretoolHook(readSettings(path));
  writeFileSync(path, `${JSON.stringify(stripped, null, 2)}\n`);
  stdout.write(`gw: removed the PreToolUse guard from ${CLAUDE_SETTINGS}\n`);
}

function agentHookInstalled(root) {
  const path = join(root, CLAUDE_SETTINGS);
  return existsSync(path) && readFileSync(path, 'utf8').includes(PRETOOL);
}

function installWorkflow({ root, force, stdout }) {
  const path = join(root, WORKFLOW);
  if (existsSync(path) && !force) {
    stdout.write(`gw: ${WORKFLOW} already exists — re-run with --force to replace it\n`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, workflowText());
  stdout.write(`gw: wrote ${WORKFLOW}\n`);
}

export function run(ctx, { git = createGit(), probe = defaultProbe } = {}) {
  const action = ctx.positionals[0] ?? 'status';
  if (!ACTIONS.includes(action)) throw new UsageError(`unknown hook action '${action}'; expected ${ACTIONS.join(', ')}.`);

  // T-0011 — same voice as gc: a board outside a git repository gets the
  // problem and the fix, not git's raw stderr, at the same exit 3.
  let dir;
  let viaConfig;
  try {
    ({ dir, viaConfig } = hooksDir(git, ctx.root));
  } catch (error) {
    if (!/not a git repository/i.test(String(error.message))) throw error;
    throw new IOError(`gw hook needs a git repository: ${ctx.root} is not inside one. Run \`git init\` in this directory, or run gw hook from a git checkout.`);
  }
  const path = join(dir, 'commit-msg');

  if (action === 'install') {
    installHook({ path, stdout: ctx.stdout, root: ctx.root });
    if (viaConfig) ctx.stdout.write(`gw: this repository sets core.hooksPath, so the hook was installed under ${dir}\n`);
    if (ctx.flags.ci) installWorkflow({ root: ctx.root, force: ctx.flags.force, stdout: ctx.stdout });
    if (ctx.flags.agent) installAgentHook({ root: ctx.root, stdout: ctx.stdout });
    ctx.stdout.write('gw: commits must now name, claim, or branch on an item. `git commit --no-verify` still bypasses it, by design.\n');
    // T-0067 — said loudly, before the announcement can be trusted. The
    // exit code stays 0: the hook IS installed, and fail-open remains correct.
    if (!probe()) ctx.stdout.write(`${GUARD_WARNING}\n`);
    return 0;
  }

  if (action === 'uninstall') {
    if (!hookInstalled(path)) {
      ctx.stdout.write('gw: no gatewright commit-msg hook is installed\n');
      return 0;
    }
    const rest = removeBlock(readFileSync(path, 'utf8'));
    // A file that is nothing but the shebang we wrote is ours to remove; one
    // with anything else in it belonged to the repository first.
    if (rest.trim() === SHEBANG) rmSync(path);
    else writeFileSync(path, rest.endsWith('\n') ? rest : `${rest}\n`);
    ctx.stdout.write(`gw: removed the gatewright commit-msg hook from ${relative(ctx.root, path) || path}\n`);
    if (ctx.flags.agent) uninstallAgentHook({ root: ctx.root, stdout: ctx.stdout });
    if (ctx.flags.ci && existsSync(join(ctx.root, WORKFLOW))) {
      rmSync(join(ctx.root, WORKFLOW));
      ctx.stdout.write(`gw: removed ${WORKFLOW}\n`);
    }
    return 0;
  }

  const installed = hookInstalled(path);
  // Windows has no executable bit for git to consult -- Git for Windows runs
  // the hook through its bundled sh regardless -- so reporting one there would
  // be a warning about a condition the platform cannot be in.
  const executable = !installed || process.platform === 'win32' || (() => {
    try { return Boolean(statSync(path).mode & 0o111); } catch { return false; }
  })();
  ctx.stdout.write(installed
    ? `commit-msg hook: installed at ${relative(ctx.root, path) || path}${executable ? '' : ' (not executable — git will skip it; run `gw hook install`)'}\n`
    : 'commit-msg hook: not installed — run `gw hook install`\n');
  ctx.stdout.write(existsSync(join(ctx.root, WORKFLOW))
    ? `CI check: ${WORKFLOW}\n`
    : 'CI check: not installed — run `gw hook install --ci`\n');
  ctx.stdout.write(agentHookInstalled(ctx.root)
    ? `agent pre-edit guard: ${CLAUDE_SETTINGS}\n`
    : 'agent pre-edit guard: not installed — run `gw hook install --agent` (or install the Claude Code plugin in adapters/claude-code)\n');
  // T-0067 — only meaningful when the hook is installed: a failed probe with
  // no hook would be a warning about a condition the repository is not in.
  if ((installed || agentHookInstalled(ctx.root)) && !probe()) ctx.stdout.write(`${GUARD_WARNING}\n`);
  return 0;
}

export { spliceBlock, removeBlock, workflowText };
