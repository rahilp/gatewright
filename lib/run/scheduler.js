import { readConfig, readStages } from '../config.js';
import { isSchedulable } from '../policy.js';
import { nextStage } from '../rules.js';
import { createRunRegistry } from './registry.js';
import { createRunner } from './spawn.js';
import { createWorktree } from './worktree.js';
import { createRunLifecycle } from './lifecycle.js';

function hasOutstandingDispatch(events, id) {
  let outstanding = false;
  for (const event of events) {
    if (event.item !== id) continue;
    if (event.type === 'dispatch') outstanding = true;
    if (event.type === 'run_ended' || event.type === 'cancel') outstanding = false;
  }
  return outstanding;
}

function priorityIndex(config, item) {
  const priorities = config.vocab?.priority;
  const index = Array.isArray(priorities) ? priorities.indexOf(item.priority) : -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function eligible(item, context) {
  if (!isSchedulable(item, context)) return false;
  const target = nextStage(context.stages, item.stage);
  if (!(context.stages.stages ?? []).find((stage) => stage.id === target)?.auto) return false;
  return hasOutstandingDispatch(context.events, item.id);
}

function defaultRunId() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dispatchPromptValues(events, id) {
  const dispatch = events.filter((event) => event.item === id && event.type === 'dispatch').at(-1);
  return dispatch?.log_tail === undefined ? {} : { log_tail: dispatch.log_tail };
}

// A tick intentionally picks at most one item.  The durable registry is read
// before choosing and again immediately before the expensive runner boundary.
export function createScheduler({ store, runner = createRunner(), registry = createRunRegistry({ store }), lifecycle = createRunLifecycle({ store, registry }), worktree = createWorktree(), makeRunId = defaultRunId, stdout = process.stdout } = {}) {
  if (!store) throw new TypeError('createScheduler requires a store.');

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
    const context = { config, stages, items, events };
    const activeItems = new Set(initialRecords.map((record) => record.item));
    const candidate = items.filter((item) => !activeItems.has(item.id) && eligible(item, context)).sort((a, b) => (
      priorityIndex(config, a) - priorityIndex(config, b)
      || String(a.updated ?? '').localeCompare(String(b.updated ?? ''))
      || String(a.id).localeCompare(String(b.id))
    ))[0];
    if (!candidate) return { status: 'idle' };

    // This second disk read is deliberately next to spawn: a concurrent tick
    // must be refused before it reaches the provider boundary.
    if (registry.list().records.length >= max) return { status: 'at_capacity' };
    const prepared = worktree.ensure({ root: store.root, item: candidate, config });
    const run = makeRunId();
    const started = runner.start({ config, item: candidate, run, worktree: prepared.path, root: store.root, registry, stages, items, promptValues: { target_stage: nextStage(stages, candidate.stage), ...dispatchPromptValues(events, candidate.id) } });
    store.withLock(() => {
      const latest = store.readItems(); const item = latest.find((entry) => entry.id === candidate.id);
      if (item) { item.owner = `agent:${run}`; item.updated = new Date().toISOString(); store.writeItems(latest); }
      store.appendEvent({ type: 'run_started', item: candidate.id, run, provider: started.provider, worktree: prepared.path, by: 'scheduler' });
    });
    return { status: 'started', item: candidate.id, run, worktree: prepared.path, started };
  }
  return { tick };
}
