// hook — installs the two places `gw guard` can stand: the local commit-msg
// hook, and a CI workflow. Nothing here decides anything; both installations
// are thin routes to `gw guard`, so the rule lives in one module and a hook
// that drifts out of date still asks the current CLI.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { UsageError } from '../cli/errors.js';
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
  const kept = existing.filter((entry) => !(entry?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes(PRETOOL)));
  next.hooks.PreToolUse = [...kept, {
    matcher: 'Edit|Write|MultiEdit|NotebookEdit',
    hooks: [{ type: 'command', command: PRETOOL }],
  }];
  return next;
}

export function withoutPretoolHook(settings) {
  const entries = Array.isArray(settings.hooks?.PreToolUse) ? settings.hooks.PreToolUse : [];
  const kept = entries.filter((entry) => !(entry?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes(PRETOOL)));
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

export function run(ctx, { git = createGit() } = {}) {
  const action = ctx.positionals[0] ?? 'status';
  if (!ACTIONS.includes(action)) throw new UsageError(`unknown hook action '${action}'; expected ${ACTIONS.join(', ')}.`);

  const { dir, viaConfig } = hooksDir(git, ctx.root);
  const path = join(dir, 'commit-msg');

  if (action === 'install') {
    installHook({ path, stdout: ctx.stdout, root: ctx.root });
    if (viaConfig) ctx.stdout.write(`gw: this repository sets core.hooksPath, so the hook was installed under ${dir}\n`);
    if (ctx.flags.ci) installWorkflow({ root: ctx.root, force: ctx.flags.force, stdout: ctx.stdout });
    if (ctx.flags.agent) installAgentHook({ root: ctx.root, stdout: ctx.stdout });
    ctx.stdout.write('gw: commits must now name, claim, or branch on an item. `git commit --no-verify` still bypasses it, by design.\n');
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
  const executable = installed && (() => {
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
  return 0;
}

export { spliceBlock, removeBlock, workflowText };
