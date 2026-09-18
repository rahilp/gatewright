// guard — the commit-time half of `gw check`. `check` audits the board; this
// audits the repository against the board, and it is the only command whose
// failure is meant to stop something outside gw from happening.
import { readFileSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { isWithin } from '../util/paths.js';
import { UsageError } from '../cli/errors.js';
import { readConfig, readStages } from '../config.js';
import { createGit } from '../git.js';
import { guardCommit, guardSettings } from '../guard.js';

export const spec = {
  summary: 'refuse a commit that is not accounted for on the board',
  flags: {
    'message-file': { type: 'string' },
    message: { type: 'string' },
    branch: { type: 'string' },
    range: { type: 'string' },
    pretool: { type: 'boolean' },
    tool: { type: 'string' },
    file: { type: 'string' },
    warn: { type: 'boolean' },
    json: { type: 'boolean' },
  },
  positionals: [],
};

// A commit message file still holds the comment block git strips later, and a
// `#` line routinely names branches and files. Judging the commit by text git
// is about to throw away would pass commits on the strength of a comment.
function stripComments(text) {
  return String(text ?? '').split('\n').filter((line) => !line.startsWith('#')).join('\n');
}

function currentBranch(git, cwd) {
  try {
    const name = git.run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).stdout.trim();
    return name === 'HEAD' ? '' : name;
  } catch { return ''; }
}

function stagedFiles(git, cwd) {
  try {
    return git.run(['diff', '--cached', '--name-only'], { cwd }).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch { return []; }
}

// One commit in a range: its subject+body, and the paths it touched. `show`
// with an empty --format prints only the name list, including for a merge's
// first parent, which is the diff CI cares about.
function commitsIn(git, cwd, range) {
  const shas = git.run(['rev-list', '--no-merges', '--reverse', range], { cwd }).stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return shas.map((sha) => ({
    sha,
    message: git.run(['log', '-1', '--format=%B', sha], { cwd }).stdout,
    files: git.run(['show', '--name-only', '--format=', sha], { cwd }).stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  }));
}

function report(ctx, verdict, { subject, mode }) {
  const label = subject ? `${subject}: ` : '';
  if (verdict.ok) {
    // T-0028 — a named item that is already finished still passes, with a
    // one-line warning so the author knows the vouch was a finished item,
    // not an in-flight one. A passing verdict is otherwise silent: a hook
    // that chatters gets uninstalled.
    for (const warning of verdict.warnings ?? []) ctx.stderr.write(`gw: warning: ${label}${warning}\n`);
    return;
  }
  const lead = mode === 'warn' ? 'gw: warning:' : 'gw:';
  ctx.stderr.write(`${lead} ${label}this change is not on the board.\n`);
  ctx.stderr.write(`  ${verdict.reason}.\n`);
  ctx.stderr.write('  Fix one of:\n');
  for (const fix of verdict.fixes ?? []) ctx.stderr.write(`    ${fix}\n`);
  if (mode !== 'warn') ctx.stderr.write('  Deliberate exception: git commit --no-verify\n');
}

// The commit hook is the last line; this is the first. An agent that starts
// editing before anything is on the board has already made the board wrong,
// and telling it so an hour later at commit time means the plan it should have
// written down is gone. Provider hooks (see adapters/) pipe their tool call in
// here before the edit happens.
function readToolCall(readStdin, flags) {
  if (flags.tool || flags.file) return { tool_name: flags.tool ?? 'Edit', tool_input: { file_path: flags.file ?? '' } };
  try { return JSON.parse(readStdin() || '{}'); } catch { return {}; }
}

function deny(ctx, reason) {
  // The provider contract: a decision object on stdout, exit 0. Exiting
  // non-zero would read as a broken hook rather than a refused edit, and a
  // broken hook is what gets switched off.
  ctx.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  })}\n`);
  return 0;
}

function pretool(ctx, { git, readStdin, config, stages, items, branch }) {
  const call = readToolCall(readStdin, ctx.flags);
  const path = call.tool_input?.file_path ?? call.tool_input?.path ?? '';
  const settings = guardSettings(config);
  // An edit to the board itself, or to anything outside the repository, is not
  // the kind of work a board tracks. Containment is asked through the shared
  // helper: on Windows an absolute path on another drive is not `..`-relative
  // to the root, and judging it by prefix alone would gate /etc/hosts.
  if (!path) return 0;
  if (isAbsolute(path) && !isWithin(path, ctx.root)) return 0;
  const within = isAbsolute(path) ? relative(ctx.root, path) : path;

  const verdict = guardCommit({
    message: '', branch, files: [within.replace(/\\/g, '/')], items, actor: ctx.actor, stages, config,
  });
  if (verdict.ok || settings.mode === 'warn') return 0;
  return deny(ctx, [
    `Nothing on the gatewright board accounts for this edit: ${verdict.reason}.`,
    'Put the work on the board first — it is how anyone else finds out what you are doing:',
    '  1. gw brief — check whether the item already exists',
    '  2. gw add "<the change>" --phase <phase>  (one item per step you plan to take; --parent <id> for sub-steps)',
    '  3. gw claim <id> — then make this edit',
    'Record the plan as items and notes now, not after the code is written.',
  ].join('\n'));
}

export function run(ctx, { git = createGit(), readStdin = () => readFileSync(0, 'utf8') } = {}) {
  const config = readConfig(ctx.store);
  const settings = guardSettings(config);
  const mode = ctx.flags.warn ? 'warn' : settings.mode;

  if (ctx.flags['message-file'] && ctx.flags.message) {
    throw new UsageError('pass --message or --message-file, not both.');
  }
  if (!settings.enabled) {
    if (ctx.flags.json) ctx.stdout.write(`${JSON.stringify({ enabled: false, results: [] })}\n`);
    return 0;
  }

  const stages = readStages(ctx.store);
  const items = ctx.store.readItems();
  const cwd = ctx.root;
  const branch = ctx.flags.branch ?? currentBranch(git, cwd);

  if (ctx.flags.pretool) return pretool(ctx, { git, readStdin, config, stages, items, branch });

  let subjects;
  if (ctx.flags.range) {
    subjects = commitsIn(git, cwd, ctx.flags.range).map((commit) => ({
      label: `${commit.sha.slice(0, 8)} ${commit.message.split('\n')[0].trim()}`,
      sha: commit.sha,
      message: commit.message,
      files: commit.files,
      // Nobody's claim survives into CI: the actor there is the runner, not
      // whoever wrote the commit. A range is judged on what the commit itself
      // says, which is the only thing that travels with it.
      actor: null,
    }));
  } else {
    const message = ctx.flags['message-file']
      ? stripComments(readFileSync(ctx.flags['message-file'], 'utf8'))
      : (ctx.flags.message ?? '');
    subjects = [{ label: '', sha: null, message, files: stagedFiles(git, cwd), actor: ctx.actor }];
  }

  const results = subjects.map((subject) => ({
    ...subject,
    verdict: guardCommit({ message: subject.message, branch, files: subject.files, items, actor: subject.actor, stages, config }),
  }));
  const refused = results.filter((result) => !result.verdict.ok);

  if (ctx.flags.json) {
    ctx.stdout.write(`${JSON.stringify({
      enabled: true,
      mode,
      results: results.map((result) => ({ sha: result.sha, ...result.verdict })),
    })}\n`);
  } else {
    // Every verdict is reported, not just the refusals: report prints nothing
    // for a plain pass, so silence for a clean commit is preserved — but a
    // passing verdict that carries a warning (T-0028) must reach the author.
    for (const result of results) report(ctx, result.verdict, { subject: result.label, mode });
  }
  return refused.length && mode !== 'warn' ? 1 : 0;
}
