// init — the one command that creates the root. It installs the shipped
// templates, writes the fenced agent-instruction block into AGENTS.md, and
// mirrors the block into provider instruction files only where the provider's
// artifact is already present, unless --mirror explicitly opts in.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../cli/errors.js';
import { createStore } from '../store.js';
import { BLOCK_TARGETS, readPipelinePreset, readTemplate, upsertBlockFile } from '../templates.js';
import { createGh } from '../sync/gh.js';
import { createPrompter, isInteractive } from '../tui/prompt.js';
import { run as runHook } from './hook.js';

export const spec = {
  summary: 'create .gatewright/, agent instructions, and a fitting pipeline',
  flags: { force: { type: 'boolean' }, mirror: { type: 'string' }, gh: { type: 'boolean' }, repo: { type: 'string' }, pipeline: { type: 'string' }, 'no-hook': { type: 'boolean' }, yes: { type: 'boolean' }, 'no-input': { type: 'boolean' } },
  positionals: [],
  needsRoot: false,
};

export async function run(ctx) {
  const { flags, cwd, stdout } = ctx;
  const root = cwd;
  const initialized = existsSync(join(root, '.gatewright'));

  const valid = new Map(BLOCK_TARGETS.map((target) => [target.name, target]));
  const requested = new Set();
  if (flags.mirror !== undefined) {
    for (const value of flags.mirror.split(',')) {
      const name = value.trim().toLowerCase();
      if (name === 'all') {
        for (const target of BLOCK_TARGETS) requested.add(target.name);
      } else if (valid.has(name)) {
        requested.add(name);
      } else {
        throw new UsageError(`unknown --mirror target '${value.trim()}'; valid targets: claude, cursor, copilot, all`);
      }
    }
  }

  // Instruction files first: they are user-owned. A malformed AGENTS.md fails
  // here, before anything is created, so the repo is never half-initialized.
  const touched = [];
  const agentsPath = join(root, 'AGENTS.md');
  const agentsExisted = existsSync(agentsPath);
  upsertBlockFile(agentsPath);
  touched.push({ file: 'AGENTS.md', action: flags.force ? 'refreshed' : agentsExisted ? 'updated' : 'wrote' });
  const skipped = [];
  for (const target of BLOCK_TARGETS) {
    const path = join(root, target.file);
    const existed = existsSync(path);
    const detected = target.signals.some((signal) => existsSync(join(root, signal)));
    const invited = requested.has(target.name) || detected;
    if (invited) {
      upsertBlockFile(path);
      touched.push({ file: target.file, action: flags.force ? 'refreshed' : existed ? 'updated' : 'wrote' });
    } else {
      skipped.push(target);
    }
  }

  for (const { file, action } of touched) {
    stdout.write(action === 'updated'
      ? `gw: updated ${file}\n`
      : `gw: ${action} the work-tracking block to ${file}\n`);
  }
  if (skipped.length) {
    const names = skipped.map((target) => target.label);
    const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    stdout.write(`gw: no ${joined} project signal was found — add instructions later with \`gw init --mirror ${skipped.map((target) => target.name).join(',')}\`\n`);
  }

  if (initialized) {
    if (flags.gh) enableGithub({ root, configPath: join(root, '.gatewright', 'config.json'), repo: flags.repo, run: ctx.ghRun, stdout });
    stdout.write('gw: .gatewright/ already exists — data files in .gatewright/ were not touched. Run `gw init --force` to refresh the agent-instruction block.\n');
    return 0;
  }

  const store = createStore(root);
  store.ensure();
  const githubRepo = repoFromGitConfig(root);
  const preset = await choosePreset(ctx, { githubRepo });
  const pipeline = readPipelinePreset(preset.name);
  writeFileSync(store.paths.stages, `${JSON.stringify(pipeline.stages, null, 2)}\n`);
  writeFileSync(store.paths.config, readTemplate('config.json'));
  const config = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  config.policy = { ...config.policy, ...pipeline.policy };
  writeFileSync(store.paths.config, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(store.paths.prompt, readTemplate('prompt.md'));
  stdout.write('gw: initialized .gatewright/\n');
  stdout.write(`gw: pipeline: ${preset.name} — ${preset.name === 'solo'
    ? 'backlog → building → done; no PR or triage hold'
    : 'backlog → building → built → in review → reviewed → merged → verified; PR review and triage are on'}\n`);
  stdout.write('gw: change the pipeline later from the Stages view in `gw serve`\n');

  if (flags.gh || preset.linkGithub) enableGithub({ root, configPath: store.paths.config, repo: flags.repo, run: ctx.ghRun, stdout });
  else if (githubRepo) stdout.write(`gw: GitHub origin found (${githubRepo}) — link it later with \`gw init --gh\`\n`);

  installInitialHook({ ...ctx, root });

  // Every file gw just wrote (stages, config, prompt, the setup wizard's
  // answers, the --gh enablement) is a write gw performed, so the digest is
  // baselined here: a fresh board's first `gw check` verifies clean instead of
  // being accused of tampering with files init itself wrote.
  store.rebaselineDigest();

  stdout.write('Next: `gw add "<title>"`, then `gw serve` for the live board (or `gw open` for a snapshot).\n');
  return 0;
}

const PIPELINES = new Set(['solo', 'team']);

async function choosePreset(ctx, { githubRepo }) {
  const requested = ctx.flags.pipeline;
  if (requested !== undefined && !PIPELINES.has(requested)) throw new UsageError(`unknown pipeline '${requested}'; choose solo or team`);
  const fallback = githubRepo ? 'team' : 'solo';
  if (requested || !isInteractive({ flags: ctx.flags, env: ctx.env, input: ctx.stdin, output: ctx.stdout })) return { name: requested ?? fallback, linkGithub: false };

  let githubReady = false;
  if (githubRepo) {
    try { createGh({ run: ctx.ghRun, repo: githubRepo }).authStatus(); githubReady = true; } catch { /* the normal choice still works */ }
  }
  const choices = [
    { value: 'solo', label: 'Solo', detail: 'Finish work locally: no pull request and no triage hold.' },
    { value: 'team', label: 'Team', detail: 'Use pull-request review and hold agent-created work for triage.' },
    ...(githubReady ? [{ value: 'team-github', label: 'Team + GitHub link', detail: `Use team review and link ${githubRepo} now.` }] : []),
  ];
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stdout });
  try {
    const value = await prompter.select('Choose a workflow:', choices, { fallback: choices.findIndex((choice) => choice.value === fallback) });
    return { name: value === 'team-github' ? 'team' : value, linkGithub: value === 'team-github' };
  } finally { prompter.close(); }
}

function isGitCheckout(root) {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return false;
  try { return statSync(dotGit).isFile() || existsSync(join(dotGit, 'HEAD')); } catch { return false; }
}

function installInitialHook(ctx) {
  if (ctx.flags['no-hook']) {
    ctx.stdout.write('gw: skipped the commit hook (--no-hook)\n');
    return;
  }
  if (!isGitCheckout(ctx.root)) {
    ctx.stdout.write('gw: skipped the commit hook (not a Git repository)\n');
    return;
  }
  const hookRun = ctx.hookRun ?? runHook;
  hookRun({ ...ctx, flags: {}, positionals: ['install'], cwd: ctx.root });
  ctx.stdout.write('gw: the commit hook keeps commits tied to board work; remove it with `gw hook uninstall`\n');
}

function repoFromGitConfig(root) {
  // Reading Git's local config, rather than running git, keeps init usable in
  // minimal environments and makes this discovery fixture-testable.
  const configPath = join(root, '.git', 'config');
  if (!existsSync(configPath)) return null;
  const section = readFileSync(configPath, 'utf8').split(/\r?\n(?=\[)/)
    .find((block) => block.startsWith('[remote "origin"]')) ?? '';
  const url = /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim();
  if (!url) return null;
  const github = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  return github ? `${github[1]}/${github[2]}` : null;
}

const DEFAULT_SYNC_INTERVAL_MIN = 5;

function enableGithub({ root, configPath, repo: override, run, stdout }) {
  const repo = override ?? repoFromGitConfig(root);
  if (!repo) {
    stdout.write('gw: GitHub sync was not enabled: no GitHub origin remote was found. Re-run with `gw init --gh --repo owner/name`.\n');
    return;
  }
  try {
    createGh({ run, repo }).authStatus();
  } catch (error) {
    stdout.write(`gw: GitHub sync was not enabled: ${error.message}\n`);
    return;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.github.enabled = true;
  config.github.repo = repo;
  // Enabling sync has to mean it syncs. The serve controller needs an interval
  // as well as a repo, and leaving it null produced a config that read
  // enabled: true while the board reported sync "off" and never pulled an
  // issue -- with nothing on screen explaining the contradiction.
  if (!Number.isFinite(config.github.sync_interval_min) || config.github.sync_interval_min <= 0) {
    config.github.sync_interval_min = DEFAULT_SYNC_INTERVAL_MIN;
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  // A config write gw performed must never be reported by `gw check` as an
  // out-of-band write. On a fresh board this baseline is refreshed again at
  // the end of init; on an already-initialized board (where enableGithub can
  // be reached with `gw init --gh` and no store exists yet) this is the only
  // baseline, and it is what keeps `gw check` clean.
  createStore(root).rebaselineDigest();
  stdout.write(`gw: enabled GitHub sync for ${repo}, polling every ${config.github.sync_interval_min} min while \`gw serve\` runs\n`);
}
