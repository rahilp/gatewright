import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { readConfig, readStages } from '../config.js';
import { evaluateCumulative, nextStage, stageIndex, stageList } from '../rules.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { invoke } from './invoke.js';
import { createGh } from '../sync/gh.js';
import { pull } from '../sync/pull.js';
import { push } from '../sync/push.js';
import { createRunRegistry } from '../run/registry.js';
import { createRunLifecycle } from '../run/lifecycle.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function loopback(value) {
  if (!value) return false;
  try { return LOOPBACK.has(new URL(value).hostname); } catch {
    return LOOPBACK.has(value.split(':')[0]) || value.startsWith('[::1]');
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; let settled = false; const chunks = [];
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true; const error = new Error('request body is too large'); error.status = 413;
        reject(error); return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { const error = new Error('request body must be valid JSON'); error.status = 400; reject(error); }
    });
    req.on('error', reject);
  });
}

function writeAllowed(req) {
  const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  return loopback(req.headers.host) && Boolean(req.headers.origin) && loopback(req.headers.origin) && contentType === 'application/json';
}

function requestActor(body, env) {
  const value = body.by ?? body.actor ?? env.GW_ACTOR ?? env.USER ?? env.USERNAME ?? 'unknown';
  return /^(human|agent):/.test(value) ? value : `human:${value}`;
}

function commandRequest(pathname, body, actor) {
  const match = pathname.match(/^\/api\/items\/([^/]+)(?:\/(move|note|triage|resume))?$/);
  if (pathname === '/api/items') {
    const { title, ...flags } = body;
    return { command: 'add', flags: { ...flags, by: actor }, positionals: [title] };
  }
  if (!match) return null;
  const [, id, action] = match;
  if (action === 'move') return { command: 'move', flags: { evidence: body.evidence ?? [], by: actor }, positionals: [id, body.to] };
  if (action === 'note') return { command: 'note', flags: { by: actor }, positionals: [id, body.text] };
  if (action === 'triage') {
    const approve = body.action === 'approve';
    const drop = body.action === 'drop';
    if (!approve && !drop) throw new UsageError('triage action must be "approve" or "drop"');
    return { command: 'triage', flags: { approve, drop, by: actor }, positionals: [id] };
  }
  if (action === 'resume') return { command: 'resume', flags: {}, positionals: [id] };
  const { ...flags } = body;
  return { command: 'edit', flags: { ...flags, by: actor }, positionals: [id] };
}

// Mirrors only the scheduler's admission gate (config.runner shape), not its
// eligibility/candidate logic -- that stays a single implementation in
// lib/run/scheduler.js. This lets /api/state report honestly why nothing
// will run without re-deriving which item would run next.
function schedulerStatus(config, registry) {
  const runnerConfig = config.runner ?? {};
  if (!runnerConfig.enabled) return { status: 'disabled', message: 'scheduler is disabled (set runner.enabled to true to start it).' };
  if (!runnerConfig.provider || !runnerConfig.providers?.[runnerConfig.provider]) {
    return { status: 'unconfigured', message: 'scheduler is enabled but config.runner.provider is not configured.' };
  }
  if (runnerConfig.paused) return { status: 'paused' };
  const max = Number.isInteger(runnerConfig.max_concurrent) && runnerConfig.max_concurrent >= 0 ? runnerConfig.max_concurrent : 1;
  if (registry.list().records.length >= max) return { status: 'at_capacity' };
  return { status: 'idle' };
}

function appendItemEvent(store, id, type, actor) {
  return store.withLock(() => {
    if (!store.readItems().some((item) => item.id === id)) throw new UsageError(`unknown item: ${id}`);
    store.appendEvent({ type, item: id, by: actor });
  });
}

function setPaused(store, paused, actor) {
  return store.withLock(() => {
    const config = readConfig(store);
    config.runner = { ...(config.runner ?? {}), paused };
    writeFileSync(store.paths.config, JSON.stringify(config, null, 2) + '\n');
    store.appendEvent({ type: paused ? 'pause_all' : 'resume_all', by: actor });
  });
}

function errorResponse(res, error) {
  if (error instanceof RuleError) return sendJson(res, 409, { error: error.message, failures: error.failures });
  if (error instanceof UsageError || error?.status === 400) return sendJson(res, 400, { error: error.message });
  if (error?.status === 413) return sendJson(res, 413, { error: error.message });
  return sendJson(res, 500, { error: error?.message ?? 'internal server error' });
}

const MAX_SYNC_BACKOFF_MS = 30 * 60 * 1000;

function createSyncController({ store, env, stderr = process.stderr, ghRun, clock = {}, syncFn } = {}) {
  const now = clock.now ?? (() => Date.now());
  const setTimer = clock.setTimeout ?? ((fn, delay) => setTimeout(fn, delay));
  const clearTimer = clock.clearTimeout ?? ((timer) => clearTimeout(timer));
  const config = readConfig(store);
  const github = config.github ?? {};
  const intervalMin = github.sync_interval_min;
  const intervalMs = Number.isFinite(intervalMin) && intervalMin > 0 ? intervalMin * 60 * 1000 : null;
  const enabled = Boolean(github.enabled && github.repo && intervalMs);
  const state = {
    enabled, intervalMin: intervalMs ? intervalMin : null, status: enabled ? 'idle' : 'off',
    lastAttemptAt: null, lastSuccessAt: null, lastError: null, consecutiveFailures: 0, nextAttemptAt: null,
  };
  let timer = null;
  let inFlight = false;

  function status() {
    const result = { ...state };
    if (enabled && result.status === 'success' && result.lastSuccessAt && now() >= Date.parse(result.lastSuccessAt) + intervalMs) result.status = 'stale';
    return result;
  }

  function defaultSync() {
    const gh = createGh({ run: ghRun, repo: github.repo });
    let issues;
    const capturingGh = { ...gh, issues(args) { issues = gh.issues(args); return issues; } };
    pull({ store, gh: capturingGh, stderr });
    const pushed = push({ store, gh: capturingGh, issues: issues ?? [], config, stages: readStages(store) });
    if (pushed.failures?.length) throw new Error(`GitHub sync push failed (${pushed.failures.length} action${pushed.failures.length === 1 ? '' : 's'})`);
    return { pulled: true, pushed };
  }

  async function tick() {
    if (!enabled || inFlight) return;
    inFlight = true;
    state.lastAttemptAt = new Date(now()).toISOString();
    state.status = 'syncing';
    try {
      await (syncFn ?? defaultSync)();
      state.status = 'success'; state.lastSuccessAt = new Date(now()).toISOString();
      state.lastError = null; state.consecutiveFailures = 0;
    } catch (error) {
      state.status = 'failure'; state.lastError = error?.message ?? String(error); state.consecutiveFailures += 1;
      stderr.write(`gw serve: scheduled GitHub sync failed: ${state.lastError}\n`);
    } finally {
      inFlight = false;
      const delay = state.status === 'failure'
        ? Math.min(intervalMs * 2 ** Math.min(state.consecutiveFailures, 10), MAX_SYNC_BACKOFF_MS)
        : intervalMs;
      state.nextAttemptAt = new Date(now() + delay).toISOString();
      timer = setTimer(() => { timer = null; tick(); }, delay);
    }
  }

  if (enabled) {
    state.nextAttemptAt = new Date(now() + intervalMs).toISOString();
    timer = setTimer(() => { timer = null; tick(); }, intervalMs);
  }

  return { status, stop() { if (timer !== null) clearTimer(timer); timer = null; } };
}

// This describes the same target set that move accepts.  Keep the decision
// here, beside the HTTP representation, but use the rules helpers rather than
// maintaining another evaluator for the viewer.
function transitionsFor(item, items, stages) {
  const terminal = (stages.terminal ?? []).includes(item.stage);
  const next = nextStage(stages, item.stage);
  const transitions = {};

  for (const target of stageList(stages)) {
    if (target.id === item.stage) continue;
    const sideStage = stageIndex(stages, target.id) < 0;

    // A terminal item can only leave through a side stage, and that departure
    // requires --force. Pipeline jumps are rejected even when forced.
    if (terminal && !sideStage) continue;

    const force = terminal || (!sideStage && target.id !== next);
    const verdict = evaluateCumulative(item, target.id, { items, stages });
    transitions[target.id] = {
      ok: verdict.ok,
      failures: verdict.failures,
      ...(force ? { force: true } : {}),
    };
  }
  return transitions;
}

export function createServeServer({ store, shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8'), env = process.env, cwd = store.root, stderr = process.stderr, ghRun, clock, syncFn } = {}) {
  const sync = createSyncController({ store, env, stderr, ghRun, clock, syncFn });
  const registry = createRunRegistry({ store });
  const lifecycle = createRunLifecycle({ store, registry });
  const server = createServer(async (req, res) => {
    // Reads accept a missing Origin because ordinary same-origin page loads send
    // none. A supplied Origin still has to be loopback.
    if (!loopback(req.headers.host) || (req.headers.origin && !loopback(req.headers.origin))) return send(res, 403, 'Gatewright serve accepts loopback requests only.\n');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'HEAD') return send(res, 200, '');
    if (req.method !== 'GET') {
      if (!writeAllowed(req)) return send(res, 403, 'Gatewright serve accepts guarded loopback writes only.\n');
      try {
        const body = await readJson(req);
        const actor = requestActor(body, env);
        const command = commandRequest(url.pathname, body, actor);
        if (command) {
          await invoke(command.command, { ...command, store, root: store.root, actor, env, cwd });
          return sendJson(res, 200, { ok: true });
        }
        const event = url.pathname.match(/^\/api\/items\/([^/]+)\/(dispatch|cancel)$/);
        if (event) {
          appendItemEvent(store, event[1], event[2], actor);
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/pause' || url.pathname === '/api/resume') {
          setPaused(store, url.pathname === '/api/pause', actor);
          return sendJson(res, 200, { ok: true });
        }
        return send(res, 404, 'Not found.\n');
      } catch (error) { return errorResponse(res, error); }
    }
    if (url.pathname === '/') return send(res, 200, shell, 'text/html; charset=utf-8');
    const transitionRequest = url.pathname.match(/^\/api\/items\/([^/]+)\/transitions$/);
    if (transitionRequest) {
      const items = store.readItems();
      const item = items.find((candidate) => candidate.id === transitionRequest[1]);
      if (!item) return send(res, 404, 'Not found.\n');
      return sendJson(res, 200, transitionsFor(item, items, readStages(store)));
    }
    const logRequest = url.pathname.match(/^\/api\/runs\/([^/]+)\/log$/);
    if (logRequest) {
      // The run id is only ever used to look up a record already on disk in
      // .gatewright/runs/. Its `log` field -- not the request -- supplies the
      // path we read, so a crafted run id can never reach the filesystem.
      const run = registry.list().records.find((candidate) => candidate.run === logRequest[1]);
      if (!run) return send(res, 404, 'Not found.\n');
      const requested = Number(url.searchParams.get('tail'));
      const tail = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 2000) : 200;
      return sendJson(res, 200, { run: run.run, item: run.item, log: lifecycle.logTail(run.log, tail) });
    }
    if (url.pathname !== '/api/state') return send(res, 404, 'Not found.\n');
    const since = url.searchParams.get('since');
    const events = store.readEvents();
    const config = readConfig(store);
    return send(res, 200, JSON.stringify({
      items: store.readItems(),
      events: since ? events.filter((event) => String(event.ts) > since) : events,
      stages: readStages(store), config, sync: sync.status(), generatedAt: new Date().toISOString(),
      runs: registry.list().records.map((record) => ({ item: record.item, run: record.run, provider: record.provider, started: record.started })),
      scheduler: schedulerStatus(config, registry),
    }), 'application/json; charset=utf-8');
  });
  server.on('close', sync.stop);
  return server;
}

export function listen(server, { port = 7777, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
  });
}
