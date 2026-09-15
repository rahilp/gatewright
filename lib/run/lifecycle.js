// Durable run termination lives outside the server: `gw stop --all` must work
// after the process that scheduled the run has disappeared.
import { existsSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { readConfig, readStages } from '../config.js';
import { resolveRoles } from '../stages.js';
import { createRunRegistry } from './registry.js';
import { taskkill, windowsProcessStartTime } from './spawn.js';
import { createMemory } from '../memory/provider.js';
import { rememberCompleted } from '../memory/write.js';

const DEFAULT_STOP_TIMEOUT_S = 30;
const LOG_TAIL_LINES = 40;
// How far a live process's start time may drift from the recorded run's
// before Windows' pid-reuse guard (see looksLikeRecordedRun) refuses it.
// Generous enough to absorb the gap between spawn.js's `started` timestamp
// and the OS actually creating the process, small enough that an unrelated
// process reusing the pid days or hours later is still rejected.
const WINDOWS_PID_REUSE_TOLERANCE_MS = 10_000;
// Bounds each individual taskkill/Get-Process shell-out on Windows —
// independent of stop_timeout_s, which bounds how long we wait for the
// *agent* to exit gracefully (see `wait()` below). This bounds how long we
// wait for the *OS command itself* to answer. Both commands are normally
// near-instant, so this is derived from stop_timeout_s (a config tuned for a
// fast or slow stop gets a proportionally fast or slow command timeout too),
// but clamped: floored so a very small stop_timeout_s — this repo's own
// tests use one as small as 0.01s — can't reach 0, which execFileSync's
// `timeout` option treats as "no timeout", silently reintroducing the exact
// unbounded hang this guards against; ceilinged so a large stop_timeout_s
// can't let a wedged command burn the whole grace window before anyone
// learns it's actually wedged.
const WINDOWS_COMMAND_TIMEOUT_FLOOR_MS = 250;
const WINDOWS_COMMAND_TIMEOUT_CEILING_MS = 5_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Waiting here must not require a server event loop: stop is also a standalone
// CLI kill switch. SIGTERM is delivered by the kernel while this thread waits.
function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// The non-blocking counterpart, for callers that have an event loop and must
// keep it turning. Deliberately not the default: `gw stop` is a kill switch
// and must not depend on one.
function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }); }

function configuredTimeout(config) {
  const seconds = Number(config.runner?.stop_timeout_s);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_STOP_TIMEOUT_S;
}

function windowsCommandTimeoutMs(config) {
  const configuredMs = configuredTimeout(config) * 1000;
  return Math.min(WINDOWS_COMMAND_TIMEOUT_CEILING_MS, Math.max(WINDOWS_COMMAND_TIMEOUT_FLOOR_MS, configuredMs));
}

// On Linux, cwd is a cheap, permission-safe identity check.  A reused pid is
// never signalled unless it is still in its recorded worktree. macOS does not
// expose this either, so it falls back to trusting the pid alone, same as
// Linux records with no worktree.
//
// Windows exposes neither `/proc` nor a permission-safe cwd lookup, so its
// guard instead compares the live process's start time against the one
// recorded when the run was spawned (see spawn.js's `started` field). This
// proves the live process is the same OS process object that was recorded —
// NOT that it is a process this tool spawned or owns, which is what the cwd
// check above proves. A pid recycled inside WINDOWS_PID_REUSE_TOLERANCE_MS by
// a coincidentally-timed process would pass this guard. That is the weaker
// guarantee Windows allows; it is intentional, not an oversight, and must not
// be "simplified" into the Linux path's stronger check (which Windows cannot
// perform) or backported to weaken Linux's.
// Returns { matches, unverified }. `unverified` is true only for the win32
// fail-open below — proceeding on a guess instead of a confirmed identity —
// and is always false on every other path, since those checks are
// synchronous, in-process, and either give a definitive answer or throw.
function looksLikeRecordedRun(run, { platform, windowsStartTimeFn, pidReuseToleranceMs, commandTimeoutMs } = {}) {
  if (!alive(run.pid)) return { matches: false, unverified: false };
  if (platform === 'win32') {
    const probe = windowsStartTimeFn(run.pid, { timeoutMs: commandTimeoutMs });
    // A wedged Get-Process is not evidence about the target process at all —
    // it is evidence that PowerShell or WMI is unhealthy right now. This is
    // reached from `gw stop`, the tool's kill switch, reached for precisely
    // when something is already going wrong (specs.md §10.1: it must work
    // "with no browser and no serve, including when serve has died"). Failing
    // this check closed on a timeout would make the switch go silently inert
    // exactly when the host is degraded and it is needed most — the wrong
    // failure direction for a panic button. So a timeout fails OPEN: treat
    // the pid as the recorded run and let escalation proceed. A definitive
    // answer — gone, or a non-timeout query error — is real evidence and
    // still fails closed, same as before: an unrelated process must never be
    // signalled on the strength of a guess.
    //
    // Failing open here is a real, if unlikely, risk: `/T` reaches the whole
    // process tree, so an unverified kill can take down more than one
    // process if the pid was in fact recycled. Silence is not an acceptable
    // price for that risk, only speed is — the caller (end(), below) must
    // make the uncertainty part of the permanent record and say it out loud
    // at the moment it happens, so an incident review can tell "confirmed
    // and killed" apart from "unconfirmed and killed anyway".
    if (probe.timedOut) return { matches: true, unverified: true };
    if (probe.startTime == null) return { matches: false, unverified: false };
    const recordedStart = Date.parse(run.started);
    const matches = !Number.isFinite(recordedStart) || Math.abs(probe.startTime - recordedStart) <= pidReuseToleranceMs;
    return { matches, unverified: false };
  }
  if (platform !== 'linux' || !run.worktree) return { matches: true, unverified: false };
  try { return { matches: readlinkSync(`/proc/${run.pid}/cwd`) === run.worktree, unverified: false }; } catch { return { matches: false, unverified: false }; }
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

function signal(run, name, identityOptions) {
  if (!looksLikeRecordedRun(run, identityOptions).matches) return false;
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

function defaultGitMessage(worktree) {
  if (!worktree) return '';
  // Read the loose commit object directly. This keeps completion offline and
  // avoids executing a git binary from the lifecycle path. Packed objects
  // simply leave this optional descriptive field empty.
  try {
    const dotGit = join(worktree, '.git'); const stat = readFileSync(dotGit, 'utf8').trim();
    const gitDir = resolve(worktree, stat.startsWith('gitdir: ') ? stat.slice(8) : dotGit);
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? readFileSync(join(gitDir, ref), 'utf8').trim() : head;
    if (!/^[0-9a-f]{40}$/i.test(sha)) return '';
    const raw = inflateSync(readFileSync(join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2)))).toString('utf8');
    return raw.slice(raw.indexOf('\0') + 1).split(/\r?\n\r?\n/)[1]?.split(/\r?\n/)[0]?.trim() ?? '';
  } catch { return ''; }
}

export function createRunLifecycle({
  store, registry = createRunRegistry({ store }), gitHead = defaultGitHead, gitMessage = defaultGitMessage, wait = pause, waitAsync = sleep, memoryTransport,
  platform = process.platform, taskkillFn = taskkill, windowsStartTimeFn = windowsProcessStartTime, pidReuseToleranceMs = WINDOWS_PID_REUSE_TOLERANCE_MS,
} = {}) {
  if (!store) throw new TypeError('createRunLifecycle requires a store.');

  const identityOptions = { platform, windowsStartTimeFn, pidReuseToleranceMs };
  function checkIdentity(run, commandTimeoutMs) {
    return looksLikeRecordedRun(run, { ...identityOptions, commandTimeoutMs });
  }
  // A fail-open identity check (see looksLikeRecordedRun) must never be a
  // quiet decision: it means a signal is about to reach a pid — and, via /T,
  // its whole process tree — that was never actually confirmed to be the
  // recorded run. `label` names which step this is (the audit trail and the
  // stderr line both need to say whether it was the graceful request or the
  // force escalation that went out unverified).
  function checkIdentityAloud(run, commandTimeoutMs, label) {
    const { matches, unverified } = checkIdentity(run, commandTimeoutMs);
    if (unverified) {
      process.stderr.write(`gw stop: could not verify pid ${run.pid} (run ${run.run}) before ${label} — the Windows identity check timed out; proceeding without confirmation.\n`);
    }
    return { matches, unverified };
  }

  // Escalation is graceful-then-forceful on every platform; only the
  // mechanism differs. POSIX signals SIGTERM then (if still alive after the
  // grace period) SIGKILL, to the run's process group when it owns one.
  // Windows has no SIGTERM equivalent — `process.kill` there terminates
  // immediately regardless of signal name — so `taskkill /PID <pid> /T`
  // (request close, whole tree) stands in for the graceful step, and
  // `taskkill /PID <pid> /T /F` (force, whole tree) for the escalation. `/T`
  // is what reaches the children an agent spawned, the same property POSIX's
  // process-group signal provides.
  //
  // Both return { timedOut }: on POSIX this is always false (the identity
  // check and the signal itself are synchronous, in-process, and cannot
  // hang), so only Windows' real shell-outs can ever report true. A caller
  // that sees timedOut must not treat the step as having succeeded — see
  // end() below, which is the only place this distinction changes behaviour.
  function requestStop(run, commandTimeoutMs) {
    if (platform === 'win32') return { timedOut: taskkillFn(run.pid, { force: false, timeoutMs: commandTimeoutMs }).timedOut };
    signal(run, 'SIGTERM', identityOptions);
    return { timedOut: false };
  }
  function forceStop(run, commandTimeoutMs) {
    if (platform === 'win32') return { timedOut: taskkillFn(run.pid, { force: true, timeoutMs: commandTimeoutMs }).timedOut };
    signal(run, 'SIGKILL', identityOptions);
    return { timedOut: false };
  }

  function commitFor(run) {
    try { return gitHead(run.worktree); } catch { return null; }
  }

  function finish(run, { code } = {}) {
    const claimed = registry.take(run);
    if (!claimed) return { status: 'already_ended', run };
    const outcome = code === 0 ? 'ok' : 'error'; const last_commit = commitFor(claimed);
    let completed;
    store.withLock(() => {
      const items = store.readItems(); const item = items.find((candidate) => candidate.id === claimed.item);
      if (item) { item.owner = null; item.last_commit = last_commit; item.updated = new Date().toISOString(); store.writeItems(items); }
      store.appendEvent({ type: 'run_ended', item: claimed.item, run: claimed.run, outcome, last_commit, by: `agent:${claimed.run}` });
      const lastMove = store.readEvents().filter((event) => event.type === 'move' && event.item === claimed.item).at(-1);
      completed = item && { item: { ...item }, from: lastMove?.from ?? item.stage, to: lastMove?.to ?? item.stage };
    });
    // This is deliberately outside the board lock and after its durable write:
    // a slow or failing backend can never delay or roll back the tracker.
    const config = readConfig(store);
    if (outcome === 'ok' && completed && config.memory?.enabled && config.memory.remember?.on_run_ok) {
      const memory = createMemory({ config, transport: memoryTransport, log: { root: store.root } });
      let commitMessage = '';
      try { commitMessage = gitMessage(claimed.worktree); } catch {}
      void rememberCompleted({ memory, root: store.root, config, ...completed, commitMessage });
    }
    return { status: 'ended', run: claimed, outcome };
  }

  // Stopping is split across the grace period so that the wait can be either
  // blocking or not, without two copies of the logic that decides whether a
  // process may be killed. `gw stop` must keep working with no event loop at
  // all -- that is what makes it a kill switch when the host is unhealthy --
  // while `gw serve` must not freeze its single thread for stop_timeout_s,
  // which with the default 30s meant the whole board stopped answering.
  function beginStop(run) {
    // Claim before signalling. A close event can arrive at any point after
    // SIGTERM; removing the record first makes this terminal outcome the only
    // one permitted to append an event.
    const claimed = registry.take(run);
    const config = readConfig(store);
    const commandTimeoutMs = windowsCommandTimeoutMs(config);
    const before = claimed && checkIdentityAloud(claimed, commandTimeoutMs, 'the graceful request');
    if (!claimed || !before.matches) return null;
    requestStop(claimed, commandTimeoutMs);
    return { claimed, commandTimeoutMs, before, graceMs: configuredTimeout(config) * 1000 };
  }

  function completeStop({ claimed, commandTimeoutMs, before }, { outcome }) {
    const run = claimed.run;
    // The identity and durable record are checked again before escalation:
    // after the grace period a recycled pid must never be force-killed.
    const after = checkIdentityAloud(claimed, commandTimeoutMs, 'the force escalation');
    let forced = { timedOut: false };
    if (after.matches) forced = forceStop(claimed, commandTimeoutMs);
    const identityUnverified = before.unverified || after.unverified;

    if (forced.timedOut) {
      // Force is supposed to be unconditional; if we cannot even confirm the
      // command ran, we do not know whether the process is dead. Claiming
      // "stopped" here would be reporting a kill that may not have happened.
      // Put the record back so a later `gw stop`/timeout sweep gets another
      // attempt, and leave the item's stage/owner untouched — an agent that
      // may still be running must not have its ownership cleared, or a
      // second one could be dispatched onto the same item.
      registry.record(claimed);
      return { status: 'stop_unconfirmed', run };
    }

    store.withLock(() => {
      const items = store.readItems(); const item = items.find((candidate) => candidate.id === claimed.item); const last_commit = commitFor(claimed);
      if (item) {
        item.prev_stage = item.stage;
        const paused = resolveRoles(readStages(store)).paused;
        if (paused) item.stage = paused;
        item.flag = 'paused'; item.owner = null; item.last_commit = last_commit; item.updated = new Date().toISOString();
        store.writeItems(items);
      }
      // identity_unverified only appears when true: a future `grep` over
      // events.jsonl for it must find exactly the kills that went out on a
      // timed-out identity check, not every ordinary stop.
      store.appendEvent({ type: 'run_ended', item: claimed.item, run: claimed.run, outcome, last_commit, by: `agent:${claimed.run}`, ...(identityUnverified ? { identity_unverified: true } : {}) });
    });
    return { status: 'stopped', run };
  }

  function end(run, { outcome }) {
    const pending = beginStop(run);
    if (!pending) return { status: 'already_stopped', run };
    wait(pending.graceMs);
    return completeStop(pending, { outcome });
  }

  // Same decisions, same order, same guarantees -- only the grace period
  // yields instead of blocking. Used by gw serve, which has an event loop to
  // keep answering with.
  async function endAsync(run, { outcome }) {
    const pending = beginStop(run);
    if (!pending) return { status: 'already_stopped', run };
    await waitAsync(pending.graceMs);
    return completeStop(pending, { outcome });
  }

  function stopItem(id, outcome = 'cancelled') {
    const runs = registry.list().records.filter((run) => run.item === id);
    const results = [];
    for (const run of runs) results.push(end(run, { outcome }));
    return results;
  }

  async function stopItemAsync(id, outcome = 'cancelled') {
    const runs = registry.list().records.filter((run) => run.item === id);
    const results = [];
    // Sequential, not concurrent: two runs on one item would otherwise
    // overlap their grace periods and race each other's identity checks.
    for (const run of runs) results.push(await endAsync(run, { outcome }));
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
      const record = previousRun ? { log: join(store.dir, 'runs', `${id}-${previousRun.run}.log`) } : null;
      const promptValues = { log_tail: logTail(record?.log) };
      store.appendEvent({ type: 'dispatch', item: id, by: 'human:resume', ...promptValues });
      return { item, promptValues };
    });
  }

  return { finish, stopItem, stopItemAsync, stopAll, enforceTimeouts, resume, logTail };
}
