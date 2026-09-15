// This is the sole process-creation boundary for runner providers.  Keep the
// injected function argv-shaped, just like lib/sync/gh.js's injected `run`.
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { isSchedulable } from '../policy.js';
import { createMemory } from '../memory/provider.js';

function defaultSpawn(argv, options) {
  return spawn(argv[0], argv.slice(1), options);
}

// Windows' termination boundary, used by lib/run/lifecycle.js. Kept here so
// that module stays the only file under lib/run/ that imports child_process.
// `/T` is the flag that reaches the process tree an agent spawned, which is
// the POSIX process-group signal's job on that platform; `/F` is the
// escalation from a graceful close request to an unconditional kill.
export function taskkill(pid, { force = false } = {}) {
  const argv = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
  try { execFileSync('taskkill', argv, { stdio: 'ignore' }); } catch { /* already exiting, or already gone */ }
  return argv;
}

// There is no Windows equivalent of /proc/<pid>/cwd, so the pid-reuse guard
// in lifecycle.js instead compares a process's recorded start time against
// this. Returns milliseconds since epoch, or null if the pid cannot be
// queried (already gone, or the query itself failed).
export function windowsProcessStartTime(pid) {
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToString('o')`], { encoding: 'utf8' });
    const parsed = Date.parse(output.trim());
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

function render(template, values) {
  return template.replace(/{{(title|scope|deps|stage|target_stage|exit|notes|log_tail|prior_context|capsule)}}/g, (_, key) => String(values[key] ?? ''));
}

function providerArgv(config, item, prompt) {
  const runner = config?.runner;
  if (!runner?.provider) throw new Error('config.runner.provider is required.');
  const provider = runner.providers?.[runner.provider];
  if (!provider) throw new Error(`config.runner.providers.${runner.provider} is not configured.`);
  if (!Array.isArray(provider.cmd) || provider.cmd.length === 0 || !provider.cmd.every((part) => typeof part === 'string')) {
    throw new Error(`config.runner.providers.${runner.provider}.cmd must be a non-empty argv array.`);
  }
  return { provider: runner.provider, argv: provider.cmd.map((part) => part.replaceAll('{prompt}', prompt).replaceAll('{item}', item.id)) };
}

// start() accepts already-rendered field values from the future scheduler, but
// owns the final template rendering and every provider invocation.
export function createRunner({ spawnFn = defaultSpawn, dryRun = false } = {}) {
  function start({ config, item, run, worktree, root, registry, onExit, stages, items, promptValues = {} }) {
    if (!item?.id) throw new TypeError('runner start requires an item with an id.');
    if (!run) throw new TypeError('runner start requires a run id.');
    if (!worktree) throw new TypeError('runner start requires a worktree.');
    if (!root) throw new TypeError('runner start requires the main repository root.');
    // Scheduler callers supply this context; use the committed policy rather
    // than duplicating eligibility rules when they do.
    if (stages || items) {
      if (!isSchedulable(item, { config, stages: stages ?? {}, items: items ?? [] })) throw new Error(`item ${item.id} is not schedulable.`);
    }

    const templatePath = resolve(root, config?.runner?.prompt_template ?? '.gatewright/prompt.md');
    const prompt = render(readFileSync(templatePath, 'utf8'), { ...promptValues, item: item.id, title: item.title, scope: item.scope, deps: (item.deps ?? []).join(', '), stage: item.stage, notes: item.notes });
    const resolved = providerArgv(config, item, prompt);
    const log = join(root, '.gatewright', 'runs', `${item.id}-${run}.log`);
    const env = { ...process.env, GW_ACTOR: `agent:${run}`, GW_ITEM: item.id, GW_ROOT: join(root, '.gatewright') };

    if (dryRun) return { prompt, argv: resolved.argv, provider: resolved.provider, log, env };

    mkdirSync(join(root, '.gatewright', 'runs'), { recursive: true });
    // The reservation is intentionally durable before invoking the provider.
    // It is immediately replaced with the child pid after spawnFn returns.
    const started = new Date().toISOString();
    registry?.record({ run, item: item.id, provider: resolved.provider, worktree, log, started });
    let child;
    try {
      child = spawnFn(resolved.argv, { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child || !Number.isInteger(child.pid)) throw new Error('runner spawn did not return a child process with a pid.');
    } catch (error) {
      registry?.clear?.(run);
      throw error;
    }
    const recorded = registry?.record({ run, item: item.id, pid: child.pid, provider: resolved.provider, worktree, log, started });
    const output = createWriteStream(log, { flags: 'a' });
    child.stdout?.pipe(output, { end: false });
    child.stderr?.pipe(output, { end: false });
    child.once?.('close', (code) => {
      output.end();
      // Terminal writes are idempotent at the registry record: stop/timeout
      // may have claimed it before this close handler gets a turn.
      onExit?.(recorded, { code });
    });
    return { prompt, argv: resolved.argv, provider: resolved.provider, child, record: recorded, log, env };
  }
  // Kept separate so the ordinary (memory-off) runner remains entirely
  // synchronous. Scheduler calls this only after the config flag is checked.
  async function startWithMemory(args, { transport, log } = {}) {
    const memory = createMemory({ config: args.config, transport, log: log ?? { root: args.root } });
    let priorContext = '';
    let capsule = '';
    if (memory.enabled && args.config.memory?.recall?.on_dispatch) {
      const hits = await memory.recall(`${args.item.title}. ${args.item.scope}`, args.config.memory.recall.top_k);
      priorContext = hits.map((hit) => `- (${hit.date}) ${hit.text}`).join('\n').slice(0, args.config.memory.recall.max_chars);
      if (args.config.memory.project_id) capsule = await memory.capsule(args.config.memory.project_id) ?? '';
    }
    return start({ ...args, promptValues: { ...args.promptValues, prior_context: priorContext, capsule } });
  }
  return { start, startWithMemory };
}
