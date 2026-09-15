// Durable run termination lives outside the server: `gw stop --all` must work
// after the process that scheduled the run has disappeared.
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readConfig, readStages } from '../config.js';
import { resolveRoles } from '../stages.js';
import { createRunRegistry } from './registry.js';

const DEFAULT_STOP_TIMEOUT_S = 30;
const LOG_TAIL_LINES = 40;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Waiting here must not require a server event loop: stop is also a standalone
// CLI kill switch. SIGTERM is delivered by the kernel while this thread waits.
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function configuredTimeout(config) {
  const seconds = Number(config.runner?.stop_timeout_s);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STOP_TIMEOUT_S;
}

// On Linux, cwd is a cheap, permission-safe identity check.  A reused pid is
// never signalled unless it is still in its recorded worktree. Other platforms
// do not expose this, so their safe fallback is the recorded pid only.
function looksLikeRecordedRun(run) {
  if (!alive(run.pid)) return false;
  if (process.platform !== 'linux' || !run.worktree) return true;
  try { return readlinkSync(`/proc/${run.pid}/cwd`) === run.worktree; } catch { return false; }
}

function processGroup(pid) {
  if (process.platform !== 'linux') return null;
  try {
    // proc stat's fifth field is the process group id; the command field may
    // contain spaces, so read after its final ')'.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) || null;
  } catch { return null; }
}

function signal(run, name) {
  if (!looksLikeRecordedRun(run)) return false;
  const group = processGroup(run.pid);
  try {
    // A run launched in its own session has pgid === pid. Never signal a
    // shared group: it could include the CLI/server that is stopping it.
    if (group === run.pid) process.kill(-group, name);
    else process.kill(run.pid, name);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function defaultGitHead(worktree) {
  if (!worktree) return null;
  // Worktrees have a .git file pointing at the main repository's git-dir.
  // Resolve HEAD directly rather than opening a second process from a kill
  // switch; this is the same value as `git -C <worktree> rev-parse HEAD` for
  // normal loose and packed refs.
  try {
    const dotGit = join(worktree, '.git'); const stat = readFileSync(dotGit, 'utf8').trim();
    const rawGitDir = stat.startsWith('gitdir: ') ? stat.slice(8) : dotGit;
    const gitDir = resolve(worktree, rawGitDir);
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head || null;
    const ref = head.slice(5); const loose = join(gitDir, ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim() || null;
    const packed = join(gitDir, 'packed-refs');
    if (!existsSync(packed)) return null;
    return readFileSync(packed, 'utf8').split(/\r?\n/).find((line) => line.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
  } catch { return null; }
}

function logTail(path, lines = LOG_TAIL_LINES) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

export function createRunLifecycle({ store, registry = createRunRegistry({ store }), gitHead = defaultGitHead, wait = pause } = {}) {
  if (!store) throw new TypeError('createRunLifecycle requires a store.');

  function commitFor(run) {
    try { return gitHead(run.worktree); } catch { return null; }
  }

  function finish(run, { code } = {}) {
    const claimed = registry.take(run);
    if (!claimed) return { status: 'already_ended', run };
    const outcome = code === 0 ? 'ok' : 'error'; const last_commit = commitFor(claimed);
    store.withLock(() => {
      const items = store.readItems(); const item = items.find((candidate) => candidate.id === claimed.item);
      if (item) { item.owner = null; item.last_commit = last_commit; item.updated = new Date().toISOString(); store.writeItems(items); }
      store.appendEvent({ type: 'run_ended', item: claimed.item, run: claimed.run, outcome, last_commit, by: `agent:${claimed.run}` });
    });
    return { status: 'ended', run: claimed, outcome };
  }

  function end(run, { outcome }) {
    // Claim before signalling. A close event can arrive at any point after
    // SIGTERM; removing the record first makes this terminal outcome the only
    // one permitted to append an event.
    const claimed = registry.take(run);
    if (!claimed || !looksLikeRecordedRun(claimed)) {
      return { status: 'already_stopped', run };
    }
    signal(claimed, 'SIGTERM');
    wait(configuredTimeout(readConfig(store)) * 1000);
    // The identity and durable record are checked again before escalation:
    // after the grace period a recycled pid must never receive SIGKILL.
    if (looksLikeRecordedRun(claimed)) signal(claimed, 'SIGKILL');

    store.withLock(() => {
      const items = store.readItems(); const item = items.find((candidate) => candidate.id === claimed.item); const last_commit = commitFor(claimed);
      if (item) {
        item.prev_stage = item.stage;
        const paused = resolveRoles(readStages(store)).paused;
        if (paused) item.stage = paused;
        item.flag = 'paused'; item.owner = null; item.last_commit = last_commit; item.updated = new Date().toISOString();
        store.writeItems(items);
      }
      store.appendEvent({ type: 'run_ended', item: claimed.item, run: claimed.run, outcome, last_commit, by: `agent:${claimed.run}` });
    });
    return { status: 'stopped', run };
  }

  function stopItem(id, outcome = 'cancelled') {
    const runs = registry.list().records.filter((run) => run.item === id);
    const results = [];
    for (const run of runs) results.push(end(run, { outcome }));
    return results;
  }

  function stopAll() {
    // Persist this first: an offline kill switch also closes the scheduler's
    // restart window before any process is signalled.
    store.withLock(() => {
      const config = readConfig(store);
      config.runner = { ...(config.runner ?? {}), paused: true };
      store.writeConfig(config);
    });
    const results = [];
    for (const run of registry.list().records) results.push(end(run, { outcome: 'cancelled' }));
    return results;
  }

  function enforceTimeouts(now = Date.now()) {
    const limit = Number(readConfig(store).runner?.run_timeout_min);
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const overdue = registry.list().records.filter((run) => Date.parse(run.started) + limit * 60_000 <= now);
    const results = [];
    for (const run of overdue) results.push(end(run, { outcome: 'timeout' }));
    return results;
  }

  function resume(id) {
    return store.withLock(() => {
      const items = store.readItems(); const item = items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`unknown item: ${id}`);
      const previous = item.prev_stage;
      if (previous) item.stage = previous;
      item.flag = null; item.owner = null; item.updated = new Date().toISOString();
      store.writeItems(items);
      const previousRun = store.readEvents().filter((event) => event.item === id && event.type === 'run_ended').at(-1);
      const record = previousRun ? { log: `${store.dir}/runs/${id}-${previousRun.run}.log` } : null;
      const promptValues = { log_tail: logTail(record?.log) };
      store.appendEvent({ type: 'dispatch', item: id, by: 'human:resume', ...promptValues });
      return { item, promptValues };
    });
  }

  return { finish, stopItem, stopAll, enforceTimeouts, resume, logTail };
}
