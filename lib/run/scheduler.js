import { readConfig, readStages } from '../config.js';
import { isSchedulable } from '../policy.js';
import { nextStage } from '../rules.js';
import { outstandingDispatches } from '../brief.js';
import { createRunRegistry } from './registry.js';
import { createRunner } from './spawn.js';
import { createWorktree } from './worktree.js';
import { createRunLifecycle } from './lifecycle.js';

// T-0133(a) -- ONE PASS OVER THE EVENTS PER TICK, NOT ONE PASS PER CANDIDATE.
//
// This used to be hasOutstandingDispatch(events, id), called from inside
// items.filter(), so every candidate walked the entire event log: O(items x
// events) on `gw serve`'s single thread, on a timer, forever. On a 2,000-item
// board with a 100k-event log that measured 1,334ms per tick, during which the
// board answered nothing at all.
//
// The definition is not re-implemented here. lib/brief.js already owns it --
// the same bookkeeping `gw brief` and `gw check` read -- and it is already one
// pass: `dispatch` opens an outstanding dispatch, `run_ended` or `cancel`
// closes it, and nothing else touches it. Sharing it is what keeps the three
// surfaces from drifting into three different answers about the same log.
// Note what is deliberately NOT a closer: `run_started`. A live run is excluded
// from the candidate list by the durable registry, not by the event log, and a
// run that dies without a run_ended is turned into one by registry.reconcile()
// rather than being silently forgotten.
function outstandingIndex(events) {
  return new Set(outstandingDispatches(events));
}

function priorityIndex(config, item) {
  const priorities = config.vocab?.priority;
  const index = Array.isArray(priorities) ? priorities.indexOf(item.priority) : -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

// T-0133(b) -- A CLAIM IS A LOCK, AND THE SCHEDULER IS NOT EXEMPT FROM IT.
//
// The scheduler used to set item.owner unconditionally once a run had started,
// so an item a human had claimed to work on by hand was handed to an agent and
// the human's name simply disappeared from the board -- with two of them then
// editing the same item, and guard refusing the human's own commit because they
// no longer owned it. An owned item is not schedulable work, full stop: not a
// human's claim, and not an earlier agent run's either, because releasing a
// stale agent claim is registry.reconcile()'s job and a second dispatch is not
// how it should happen.
//
// This rule lives here rather than in lib/policy.js isSchedulable() on purpose.
// isSchedulable answers "is this item well-formed, unheld work that its gate
// would admit", and lib/run/spawn.js re-asserts it at the provider boundary --
// by which point the scheduler has legitimately taken the claim itself. Moving
// the owner test in there would make spawn.js refuse every run the scheduler
// admits. Ownership is an admission question, so it is asked at admission.
function eligible(item, context) {
  if (!isSchedulable(item, context)) return false;
  if (item.owner != null) return false;
  const target = nextStage(context.stages, item.stage);
  if (!(context.stages.stages ?? []).find((stage) => stage.id === target)?.auto) return false;
  return context.outstanding.has(item.id);
}

function defaultRunId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dispatchPromptValues(events, id) {
  const dispatch = events.filter((event) => event.item === id && event.type === 'dispatch').at(-1);
  return dispatch?.log_tail === undefined ? {} : { log_tail: dispatch.log_tail };
}

// A tick intentionally picks at most one item.  Admission -- capacity, the
// item's claim, and the durable reservation -- is one locked compare-and-swap;
// see admit() below.
export function createScheduler({ store, runner = createRunner(), registry = createRunRegistry({ store }), lifecycle = createRunLifecycle({ store, registry }), worktree = createWorktree(), makeRunId = defaultRunId, stdout = process.stdout } = {}) {
  if (!store) throw new TypeError('createScheduler requires a store.');

  // T-0133(c) -- ADMISSION IS A COMPARE-AND-SWAP, NOT A CHECK FOLLOWED BY A HOPE.
  //
  // The tick used to read the record count, then create a worktree, then spawn,
  // holding nothing across any of it. Two supervisors on one board -- a stale
  // `gw serve` beside a fresh one, or one per checkout -- both passed the same
  // capacity check and both spawned, so max_concurrent 1 ran two agents against
  // one board. registry.take() is already the terminal half of this, a locked
  // compare-and-swap; this is the admission half, on the same board lock, and
  // its three decisions must not be separable:
  //
  //   1. refuse when the board is already at capacity;
  //   2. refuse an item another supervisor is already running;
  //   3. take the item's claim, so no one else -- agent or human -- can.
  //
  // The reservation is durable before the expensive work begins, which is what
  // makes the other supervisor's capacity check see it. The lock is released
  // before that work starts: a git worktree checkout under the board lock would
  // stall every reader, and withLock is not reentrant.
  function admit(candidate, run, max) {
    return store.withLock(() => {
      const records = registry.list().records;
      if (records.length >= max) return { status: 'at_capacity' };
      if (records.some((record) => record.item === candidate.id)) return { status: 'already_running', item: candidate.id };
      const items = store.readItems();
      const item = items.find((entry) => entry.id === candidate.id);
      if (!item) return { status: 'idle' };
      // eligible() skipped owned items already, but that read happened outside
      // this lock. This is the check that actually decides it.
      if (item.owner != null) return { status: 'claimed', item: candidate.id, owner: item.owner };
      item.owner = `agent:${run}`; item.updated = new Date().toISOString();
      store.writeItems(items);
      registry.record({ run, item: candidate.id });
      return { status: 'admitted' };
    });
  }

  // The exact inverse, for every way the work can fail after admission. Without
  // it a failed start leaves a durable reservation and a claim behind, and the
  // scheduler sits at at_capacity forever with nothing actually running -- the
  // wedge is worse than the crash, because nothing reports it.
  function release(candidate, run) {
    store.withLock(() => {
      registry.clear?.(run);
      const items = store.readItems();
      const item = items.find((entry) => entry.id === candidate.id);
      if (item?.owner !== `agent:${run}`) return;
      item.owner = null; item.updated = new Date().toISOString();
      store.writeItems(items);
    });
  }

  function tick() {
    // This intentionally precedes every admission return, including paused and
    // disabled states. A durable run must retain its deadline across supervisor
    // restarts and cannot be exempted by pausing the queue.
    lifecycle.enforceTimeouts();
    const config = readConfig(store); const runnerConfig = config.runner ?? {};
    if (!runnerConfig.enabled) return { status: 'disabled', message: 'scheduler is disabled (set runner.enabled to true to start it).' };
    if (!runnerConfig.provider || !runnerConfig.providers?.[runnerConfig.provider]) {
      return { status: 'unconfigured', message: 'scheduler is enabled but config.runner.provider is not configured.' };
    }
    if (runnerConfig.paused) return { status: 'paused' };
    const max = Number.isInteger(runnerConfig.max_concurrent) && runnerConfig.max_concurrent >= 0 ? runnerConfig.max_concurrent : 1;
    const initialRecords = registry.list().records;
    if (initialRecords.length >= max) return { status: 'at_capacity' };

    const stages = readStages(store); const items = store.readItems(); const events = store.readEvents();
    const context = { config, stages, items, events, outstanding: outstandingIndex(events) };
    const activeItems = new Set(initialRecords.map((record) => record.item));
    const candidate = items.filter((item) => !activeItems.has(item.id) && eligible(item, context)).sort((a, b) => (
      priorityIndex(config, a) - priorityIndex(config, b)
      || String(a.updated ?? '').localeCompare(String(b.updated ?? ''))
      || String(a.id).localeCompare(String(b.id))
    ))[0];
    if (!candidate) return { status: 'idle' };

    const run = makeRunId();
    const admitted = admit(candidate, run, max);
    if (admitted.status !== 'admitted') return admitted;

    let prepared;
    try { prepared = worktree.ensure({ root: store.root, item: candidate, config }); }
    catch (error) { release(candidate, run); throw error; }

    const startArgs = { config, item: candidate, run, worktree: prepared.path, root: store.root, registry, onExit: lifecycle.finish, stages, items, promptValues: { target_stage: nextStage(stages, candidate.stage), ...dispatchPromptValues(events, candidate.id) } };
    // T-0133(d) -- the memory-enabled path is asynchronous, so its failures
    // arrive as rejections. Both shapes release the admission and then report
    // the same way, so the caller has one rule to apply rather than two; see
    // superviseTick in lib/commands/serve.js, which is where a tick failure is
    // made non-fatal for the supervisor and every other live run it watches.
    if (config.memory?.enabled && typeof runner.startWithMemory === 'function') {
      return runner.startWithMemory(startArgs).then(recordStarted, (error) => { release(candidate, run); throw error; });
    }
    let started;
    try { started = runner.start(startArgs); }
    catch (error) { release(candidate, run); throw error; }
    return recordStarted(started);

    // The claim and the reservation were both taken under admit()'s lock, so
    // all that is left is the audit line. appendEvent is an atomic append in its
    // own right; taking the board lock again just to write it would serialise
    // the tick against every reader for no gain.
    function recordStarted(started) {
      store.appendEvent({ type: 'run_started', item: candidate.id, run, provider: started.provider, worktree: prepared.path, by: 'scheduler' });
      return { status: 'started', item: candidate.id, run, worktree: prepared.path, started };
    }
  }
  return { tick };
}
