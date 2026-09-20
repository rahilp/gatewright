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
import { AbortedError, createPrompter, isInteractive } from '../tui/prompt.js';
import { run as runHook } from './hook.js';

// T-0136 — specs §1 promises that everything in .gatewright/ except the run
// logs and worktrees is committed, and docs/internals.md says the worktree
// root "is ignored by the shipped `.gitignore`". No such file was ever
// shipped, so every board that ran an agent offered its logs, its worktrees
// and its lock to the next `git add -A`. These five patterns are exactly the
// files gw creates and then throws away: run logs (runs/), run worktrees
// (.worktrees/), the advisory lock, the temp files writeAtomic renames over,
// and any pid file a process leaves behind. Everything else -- items,
// events, events-archive, stages, config, prompt, .digest -- is the record,
// and `gw check` has to find it in a fresh clone.
const GITIGNORE = `# Written by gw init. Everything else in .gatewright/ is the board's record
# and belongs in git, including .digest, which is what lets \`gw check\` spot
# an out-of-band edit in a fresh clone.
runs/
.worktrees/
.lock
*.tmp
*.pid
`;

// Only ever creates. A .gitignore that is already there may have been edited
// -- it is an ordinary git file in the user's repository -- and rewriting it
// would throw that away on every `gw init --force`. Creating the board says
// nothing about it (it is part of "initialized .gatewright/", and the
// transcript agents read is pinned byte-for-byte); adding it to a board that
// already existed is news, so that caller announces it.
function ensureGitignore(store) {
  if (existsSync(store.paths.gitignore)) return false;
  writeFileSync(store.paths.gitignore, GITIGNORE);
  return true;
}

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
  const interactive = isInteractive({ flags, env: ctx.env, input: ctx.stdin, output: ctx.stdout });

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

  // Every question is asked before any file is touched, so cancelling at any
  // screen of the walkthrough -- Esc, Ctrl-C, or a terminal that goes away --
  // leaves the repo exactly as it was.
  let setup;
  try {
    setup = initialized ? null : await chooseSetup(ctx, { root, githubRepo: repoFromGitConfig(root), interactive, requested });
  } catch (error) {
    if (error instanceof AbortedError) {
      stdout.write('gw: setup cancelled — nothing was written.\n');
      return 1;
    }
    throw error;
  }
  const preset = setup?.preset;
  const declined = setup?.declined ?? new Set();
  for (const name of setup?.mirrors ?? []) requested.add(name);

  // Instruction files first: they are user-owned. A malformed AGENTS.md fails
  // here, before anything is created, so the repo is never half-initialized.
  // The full-screen walkthrough ends with one summary box, so there the
  // running log is held back and folded into it (see renderInitSummary).
  // Every other path writes straight to stdout, byte-for-byte as before.
  const log = setup?.rich ? heldLog() : stdout;
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
    const invited = requested.has(target.name) || (detected && !declined.has(target.name));
    if (invited) {
      upsertBlockFile(path);
      touched.push({ file: target.file, action: flags.force ? 'refreshed' : existed ? 'updated' : 'wrote' });
    } else {
      skipped.push(target);
    }
  }

  for (const { file, action } of touched) {
    log.write(action === 'updated'
      ? `gw: updated ${file}\n`
      : `gw: ${action} the work-tracking block to ${file}\n`);
  }
  if (skipped.length) {
    const names = skipped.map((target) => target.label);
    const joined = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    log.write(`gw: no ${joined} project signal was found — add instructions later with \`gw init --mirror ${skipped.map((target) => target.name).join(',')}\`\n`);
  }

  if (initialized) {
    // A board created before .gitignore was shipped gets it here: `gw init`
    // is already the command for "bring this project up to date".
    if (ensureGitignore(createStore(root))) {
      stdout.write('gw: wrote .gatewright/.gitignore (run logs, worktrees, locks and temp files stay out of git)\n');
    }
    if (flags.gh) enableGithub({ root, configPath: join(root, '.gatewright', 'config.json'), repo: flags.repo, run: ctx.ghRun, stdout });
    stdout.write('gw: .gatewright/ already exists — data files in .gatewright/ were not touched. Run `gw init --force` to refresh the agent-instruction block.\n');
    return 0;
  }

  const store = createStore(root);
  store.ensure();
  const githubRepo = repoFromGitConfig(root);
  const pipeline = readPipelinePreset(preset.name);
  writeFileSync(store.paths.stages, `${JSON.stringify(pipeline.stages, null, 2)}\n`);
  writeFileSync(store.paths.config, readTemplate('config.json'));
  const config = JSON.parse(readFileSync(store.paths.config, 'utf8'));
  config.policy = { ...config.policy, ...pipeline.policy };
  writeFileSync(store.paths.config, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(store.paths.prompt, readTemplate('prompt.md'));
  ensureGitignore(store);
  log.write('gw: initialized .gatewright/\n');
  log.write(`gw: pipeline: ${preset.name} — ${PIPELINE_SUMMARY[preset.name]}\n`);
  log.write('gw: change the pipeline later from the Stages view in `gw serve`\n');

  if (flags.gh || preset.linkGithub) enableGithub({ root, configPath: store.paths.config, repo: flags.repo, run: ctx.ghRun, stdout: log });
  else if (githubRepo) log.write(`gw: GitHub origin found (${githubRepo}) — link it later with \`gw init --gh\`\n`);

  const hook = installInitialHook({ ...ctx, stdout: log, root, skipHook: setup.hook === false });

  // Every file gw just wrote (stages, config, prompt, the setup wizard's
  // answers, the --gh enablement) is a write gw performed, so the digest is
  // baselined here: a fresh board's first `gw check` verifies clean instead of
  // being accused of tampering with files init itself wrote.
  store.rebaselineDigest();

  log.write('Next: `gw add "<title>"`, then `gw serve` for the live board (or `gw open` for a snapshot).\n');
  if (setup.rich) renderInitSummary(ctx, { touched, preset, hook, held: log.lines() });
  return 0;
}

const PIPELINES = new Set(['solo', 'team']);
// The steps each workflow installs, as the full-screen setup describes them.
const STEPS = {
  solo: 'backlog → building → done',
  team: 'backlog → building → built → in review → reviewed → merged → verified',
};

// The product each instruction file is for, named the way its users know it.
const TOOL_NAMES = { claude: 'Claude Code', cursor: 'Cursor', copilot: 'GitHub Copilot' };

const PIPELINE_SUMMARY = {
  solo: 'backlog → building → done; no PR or triage hold',
  team: 'backlog → building → built → in review → reviewed → merged → verified; PR review and triage are on',
};

function heldLog() {
  let text = '';
  return { write: (chunk) => { text += chunk; return true; }, lines: () => text.split('\n').filter(Boolean) };
}

// The one place init asks anything. Plain terminals get the single workflow
// question they always had; a capable terminal gets the same question as the
// first of three screens, then what to set up, then a review of exactly what
// will be written. Non-interactive runs never reach a prompt: the flags and
// the GitHub-origin default decide, as before.
async function chooseSetup(ctx, { root, githubRepo, interactive, requested }) {
  const flagged = ctx.flags.pipeline;
  if (flagged !== undefined && !PIPELINES.has(flagged)) throw new UsageError(`unknown pipeline '${flagged}'; choose solo or team`);
  const fallback = githubRepo ? 'team' : 'solo';
  if (!interactive) return { preset: { name: flagged ?? fallback, linkGithub: false }, rich: false };

  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stdout, env: ctx.env ?? process.env, platform: ctx.platform, release: ctx.osRelease, title: 'gw init' });
  const rich = prompter.rich();
  if (flagged && !rich) { prompter.close(); return { preset: { name: flagged, linkGithub: false }, rich: false }; }
  try {
    let preset = { name: flagged, linkGithub: false };
    const total = flagged ? 2 : 3;
    if (!flagged) {
      let githubReady = false;
      if (githubRepo) {
        try { createGh({ run: ctx.ghRun, repo: githubRepo }).authStatus(); githubReady = true; } catch { /* the normal choice still works */ }
      }
      // The numbered prompt keeps its original wording exactly; the full
      // screen has room to show the stages each choice installs.
      const choices = rich ? [
        { value: 'solo', label: 'Solo', detail: [`${STEPS.solo}.`, 'You finish work on your own. No review step, and nothing waits for approval.'] },
        { value: 'team', label: 'Team', detail: [`${STEPS.team}.`, 'Each change is reviewed in a GitHub pull request. Work an AI agent adds waits for your OK.'] },
        ...(githubReady ? [{ value: 'team-github', label: 'Team, linked to GitHub', detail: [`Everything in Team. Issues from ${githubRepo} also show up on the board, and item moves are posted back to them.`] }] : []),
      ] : [
        { value: 'solo', label: 'Solo', detail: 'Finish work locally: no pull request and no triage hold.' },
        { value: 'team', label: 'Team', detail: 'Use pull-request review and hold agent-created work for triage.' },
        ...(githubReady ? [{ value: 'team-github', label: 'Team + GitHub link', detail: `Use team review and link ${githubRepo} now.` }] : []),
      ];
      const value = await prompter.select(rich ? 'How do you want to work?' : 'Choose a workflow:', choices, {
        fallback: choices.findIndex((choice) => choice.value === fallback),
        step: `Step 1 of ${total}`,
        intro: ['Welcome! Gatewright keeps a to-do board for your project that you and your AI agents share. Nothing is saved until the last step.'],
        explain: 'This sets the steps an item goes through before it is done, and whether work an AI agent adds waits for your OK. You can change it later.',
      });
      preset = { name: value === 'team-github' ? 'team' : value, linkGithub: value === 'team-github' };
    }
    if (!rich) return { preset, rich };

    const git = isGitCheckout(root);
    const options = [
      { value: 'agents', label: 'AGENTS.md', locked: true, detail: 'Tells AI agents how to use the board. Most AI coding tools read this file, so it is always added.' },
      ...BLOCK_TARGETS.map((target) => {
        const detected = target.signals.some((signal) => existsSync(join(root, signal)));
        const tool = TOOL_NAMES[target.name] ?? target.label;
        return {
          value: target.name,
          label: `${target.file}${detected ? '  (found in this project)' : ''}`,
          checked: detected || requested.has(target.name),
          detail: `${tool} reads this file, so it will track its work on the board too.`,
        };
      }),
      ...(git ? [{ value: 'hook', label: 'Commit check', checked: !ctx.flags['no-hook'], detail: 'Git refuses a commit unless it names a board item or you have claimed one. To skip once: `git commit --no-verify`. To remove: `gw hook uninstall`.' }] : []),
    ];
    const picked = new Set(await prompter.multiselect('What should be set up?', options, {
      step: `Step ${total - 1} of ${total}`,
      explain: 'These let your AI tools and git know about the board. Ticked items are added when you confirm in the next step.',
    }));

    const files = ['.gatewright/  (your board)', 'AGENTS.md', ...BLOCK_TARGETS.filter((target) => picked.has(target.name)).map((target) => target.file)];
    const { g } = prompter.theme();
    const details = [
      `  Workflow      ${preset.name === 'solo' ? 'Solo' : 'Team'}${preset.linkGithub ? `, linked to GitHub (${githubRepo})` : ''}`,
      `  Commit check  ${!git ? 'not added (this folder is not a git project)' : picked.has('hook') ? 'will be added' : 'not added'}`,
      '  Files to write:',
      ...files.map((file) => `    ${g.done} ${file}`),
    ];
    const confirmed = await prompter.confirm('Create the board?', {
      fallback: true,
      details,
      step: `Step ${total} of ${total}`,
      explain: 'Nothing has been written yet. Check the list below, then choose.',
      yes: { label: 'Yes, create it', detail: 'Writes the files listed above. You can change settings later with `gw config`.' },
      no: { label: 'No, stop here', detail: 'Nothing is written. Your project stays exactly as it is.' },
    });
    if (!confirmed) throw new AbortedError('declined');
    return {
      preset,
      rich,
      mirrors: BLOCK_TARGETS.filter((target) => picked.has(target.name)).map((target) => target.name),
      declined: new Set(BLOCK_TARGETS.filter((target) => !picked.has(target.name)).map((target) => target.name)),
      hook: git ? picked.has('hook') : undefined,
    };
  } finally { prompter.close(); }
}

function isGitCheckout(root) {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) return false;
  try { return statSync(dotGit).isFile() || existsSync(join(dotGit, 'HEAD')); } catch { return false; }
}

function installInitialHook(ctx) {
  if (ctx.flags['no-hook'] || ctx.skipHook) {
    const why = ctx.flags['no-hook'] ? '--no-hook' : 'not selected';
    ctx.stdout.write(`gw: skipped the commit hook (${why})\n`);
    return `skipped (${why})`;
  }
  if (!isGitCheckout(ctx.root)) {
    ctx.stdout.write('gw: skipped the commit hook (not a Git repository)\n');
    return 'skipped (not a Git repository)';
  }
  const hookRun = ctx.hookRun ?? runHook;
  hookRun({ ...ctx, flags: {}, positionals: ['install'], cwd: ctx.root });
  ctx.stdout.write('gw: the commit hook keeps commits tied to board work; remove it with `gw hook uninstall`\n');
  return 'installed';
}

// The log lines the summary box already says in its own words. Anything held
// back that does not match one of these -- a guard-probe warning, a
// core.hooksPath note, GitHub sync results, the --mirror hint -- is carried
// into the box under Notes, so the quiet path can never lose a message.
const SUMMARIZED = [
  /^gw: (wrote|refreshed) the work-tracking block to /,
  /^gw: updated /,
  /^gw: initialized \.gatewright\//,
  /^gw: pipeline: /,
  /^gw: change the pipeline later /,
  /^gw: (installed|refreshed) the commit-msg hook at /,
  /^gw: added the gatewright block to the existing commit-msg hook at /,
  /^gw: commits must now name, claim, or branch on an item\./,
  /^gw: the commit hook keeps commits tied to board work/,
  /^gw: skipped the commit hook /,
  /^Next: /,
];

// The --mirror hint, said the way the setup screen said it. Every other held
// line is shown as gw printed it.
function plainNote(line) {
  const mirror = /^gw: no (.+) project signal was found — add instructions later with `(gw init --mirror [^`]+)`$/.exec(line);
  if (!mirror) return line;
  return `gw: to add the instruction file for ${mirror[1].replace(' and ', ' or ')} later, run \`${mirror[2]}\``;
}

// Printed on the normal screen once the walkthrough has left it, so the record
// of what init did stays in the user's scrollback. In this mode it is the
// whole report: the log lines it replaces were held back, not printed.
function renderInitSummary(ctx, { touched, preset, hook, held }) {
  const prompter = createPrompter({ input: ctx.stdin, output: ctx.stdout, env: ctx.env ?? process.env, platform: ctx.platform, release: ctx.osRelease });
  const { g } = prompter.theme();
  const installedAt = held.map((line) => /^gw: (?:installed|refreshed) the commit-msg hook at (.+)$|^gw: added the gatewright block to the existing commit-msg hook at (.+)$/.exec(line)).find(Boolean);
  const hookLines = hook === 'installed'
    ? [
      `${g.done} Commit check added${installedAt ? ` (${installedAt[1] ?? installedAt[2]})` : ''}`,
      '  To skip once: `git commit --no-verify`. To remove: `gw hook uninstall`',
    ]
    : [`- Commit check not added: ${hook.replace(/^skipped \((.*)\)$/, '$1').replace('not a Git repository', 'this folder is not a git project')}`];
  const notes = held.filter((line) => !SUMMARIZED.some((pattern) => pattern.test(line))).map(plainNote);
  prompter.panel('Board ready', [
    ...touched.map(({ file, action }) => `${g.done} ${action} ${file}`),
    `${g.done} Workflow: ${preset.name === 'solo' ? 'Solo' : 'Team'} (${STEPS[preset.name]})`,
    preset.name === 'solo'
      ? '  No review step; nothing waits for approval'
      : '  Changes are reviewed in a pull request; work an AI agent adds waits for your OK',
    '  Change the steps any time from the Stages view in `gw serve`',
    ...hookLines,
    ...(notes.length ? ['', 'Notes:', ...notes.map((line) => ({ text: `- ${line.replace(/^gw: /, '')}`, tone: /WARNING/.test(line) ? 'warn' : undefined }))] : []),
    '',
    'Next:  gw add "your first task"   add something to do',
    '       gw serve                   start the live board (a web page)',
    '       gw open                    or open a read-only copy of it',
  ]);
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
