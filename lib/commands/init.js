// init — the one command that creates the root. It installs the shipped
// templates, writes the fenced agent-instruction block into AGENTS.md, and
// mirrors the block into provider instruction files only where the provider's
// artifact is already present, unless --mirror explicitly opts in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../cli/errors.js';
import { createStore } from '../store.js';
import { BLOCK_TARGETS, readTemplate, upsertBlockFile } from '../templates.js';
import { createGh } from '../sync/gh.js';
import { isInteractive } from '../tui/prompt.js';
import { runSetup } from '../tui/setup.js';

export const spec = {
  summary: 'create .gatewright/ and the agent instruction block',
  flags: { force: { type: 'boolean' }, mirror: { type: 'string' }, gh: { type: 'boolean' }, repo: { type: 'string' }, yes: { type: 'boolean' }, 'no-input': { type: 'boolean' } },
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
    const invited = requested.has(target.name) || existed || (target.parent && existsSync(join(root, target.parent)));
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
    stdout.write(`gw: skipped ${joined} (no existing file) — add with \`gw init --mirror ${skipped.map((target) => target.name).join(',')}\`\n`);
  }

  if (initialized) {
    if (flags.gh) enableGithub({ root, configPath: join(root, '.gatewright', 'config.json'), repo: flags.repo, run: ctx.ghRun, stdout });
    stdout.write('gw: .gatewright/ already exists — data files in .gatewright/ were not touched. Run `gw init --force` to refresh the agent-instruction block.\n');
    return 0;
  }

  const store = createStore(root);
  store.ensure();
  writeFileSync(store.paths.stages, readTemplate('stages.json'));
  writeFileSync(store.paths.config, readTemplate('config.json'));
  writeFileSync(store.paths.prompt, readTemplate('prompt.md'));
  if (flags.gh) enableGithub({ root, configPath: store.paths.config, repo: flags.repo, run: ctx.ghRun, stdout });
  stdout.write('gw: initialized .gatewright/\n');

  // The walkthrough runs only with a human present. Without one the shipped
  // templates stand exactly as they did before this existed, so every agent,
  // CI job and npx one-liner sees byte-identical behaviour.
  if (isInteractive({ flags, env: ctx.env, input: ctx.stdin, output: stdout })) {
    await runSetup({ store, stdout, stdin: ctx.stdin, shippedStages: JSON.parse(readTemplate('stages.json')) });
  }

  // Every file gw just wrote (stages, config, prompt, the setup wizard's
  // answers, the --gh enablement) is a write gw performed, so the digest is
  // baselined here: a fresh board's first `gw check` verifies clean instead of
  // being accused of tampering with files init itself wrote.
  store.rebaselineDigest();

  stdout.write('Next: `gw add "<title>"` to add work, `gw open` to see the board.\n');
  return 0;
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
