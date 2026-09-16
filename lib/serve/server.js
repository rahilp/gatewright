import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { readConfig, readStages } from '../config.js';
import { validateStages } from '../stages.js';
import { SETTINGS_BY_KEY, coerce, setValue, parseGlossaryKey, applyGlossaryEntry } from '../settings.js';
import { stageList } from '../rules.js';
import { describeStage } from '../gates/describe.js';
import { transitionsFor } from '../transitions.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { invoke } from './invoke.js';
import { createGh } from '../sync/gh.js';
import { pull } from '../sync/pull.js';
import { push } from '../sync/push.js';
import { createRunRegistry } from '../run/registry.js';
import { createRunLifecycle } from '../run/lifecycle.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostnameOf(value) {
  if (!value) return null;
  try { return new URL(value).hostname; } catch {
    if (value.startsWith('[::1]')) return '::1';
    return value.split(':')[0] || null;
  }
}

// The allow-list is the CSRF boundary, not a formality. It stays a comparison
// against a fixed set of addresses this server is actually reachable on, so a
// page on some other origin still cannot drive the board through a visitor's
// browser. Widening it for --host adds this machine's own LAN addresses; it
// never becomes "any host".
function permitted(allowed, value) {
  const hostname = hostnameOf(value);
  return hostname != null && allowed.has(hostname);
}


// ADMINISTRATIVE WRITES ARE LOOPBACK-ONLY, WHATEVER --host SAYS.
//
// `permitted(allowed, ...)` is deliberately widened by --host: that is how a
// colleague on the LAN moves a card, and moving a card is the feature. Changing
// the RULES of the board -- the stages, their gates, the settings -- is not.
// So this check compares the SAME headers against LOOPBACK itself rather than
// against `allowed`, which means no --host argument can ever widen it. There is
// no authentication in this product; this check is the whole mechanism, so it
// stays a separate, stricter test and never collapses back into writeAllowed().
function adminAllowed(req) {
  return permitted(LOOPBACK, req.headers.host)
    && (!req.headers.origin || permitted(LOOPBACK, req.headers.origin));
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

function writeAllowed(req, allowed) {
  const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  // A write still requires an Origin and it still has to be one of this
  // server's own addresses. That is what stops another site driving the board
  // through a visitor's browser, and it survives --host unchanged.
  return permitted(allowed, req.headers.host) && Boolean(req.headers.origin) && permitted(allowed, req.headers.origin) && contentType === 'application/json';
}

function requestActor(body, env) {
  const value = body.by ?? body.actor ?? env.GW_ACTOR ?? env.USER ?? env.USERNAME ?? 'unknown';
  return /^(human|agent):/.test(value) ? value : `human:${value}`;
}

// The CLI declares deps and refs as comma-separated string flags. A board form
// naturally sends them as JSON arrays, so normalise here -- at the HTTP
// boundary -- rather than teaching lib/commands/edit.js a second input shape.
const EDIT_LIST_FLAGS = ['deps', 'refs'];

function editRequest(id, body, actor) {
  const flags = { ...body, by: actor };
  for (const field of EDIT_LIST_FLAGS) {
    if (Array.isArray(flags[field])) flags[field] = flags[field].join(',');
  }
  return { command: 'edit', flags, positionals: [id] };
}

function commandRequest(pathname, body, actor) {
  const match = pathname.match(/^\/api\/items\/([^/]+)(?:\/(move|note|triage|resume|edit|claim|release))?$/);
  if (pathname === '/api/items') {
    const { title, ...flags } = body;
    return { command: 'add', flags: { ...flags, by: actor }, positionals: [title] };
  }
  if (!match) return null;
  const [, id, action] = match;
  // `force` travels the same way `evidence` does. Without it the board can
  // offer a backward move -- correcting a mis-drag, which a human must be able
  // to do without opening a terminal -- and then have the CLI refuse it,
  // because a backward move is force-only by definition.
  if (action === 'move') return { command: 'move', flags: { evidence: body.evidence ?? [], force: Boolean(body.force), by: actor }, positionals: [id, body.to] };
  if (action === 'note') return { command: 'note', flags: { by: actor }, positionals: [id, body.text] };
  if (action === 'triage') {
    const approve = body.action === 'approve';
    const drop = body.action === 'drop';
    if (!approve && !drop) throw new UsageError('triage action must be "approve" or "drop"');
    return { command: 'triage', flags: { approve, drop, by: actor }, positionals: [id] };
  }
  if (action === 'resume') return { command: 'resume', flags: {}, positionals: [id] };
  // The board explains an unmet gate in English and offers the action that
  // clears it. "Someone must have claimed it" is answered by a Claim button,
  // not by telling a person with a mouse to run a CLI command.
  if (action === 'claim' || action === 'release') return { command: action, flags: { by: actor }, positionals: [id] };
  // Both the bare item path and the explicit /edit path land on the same CLI
  // command module, so the board never has a second way to mutate an item.
  return editRequest(id, body, actor);
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

function stageIdsOf(stages) {
  return [...(stages.stages ?? []), ...(stages.extra ?? [])].map((stage) => stage.id);
}

// Replacing the pipeline wholesale, because that is what the editor on the
// board produces: a reorder, a rename and a new gate arrive together and a
// per-field API would let the board persist half of them.
//
// The refusals below are the ones whose consequences a human cannot see at the
// time they click save. validateStages() is the same check `gw check` runs --
// running it here means an invalid pipeline is never written and discovered
// later. The occupancy check exists because removing a stage that still holds
// work silently orphans those items into a stage that no longer exists, which
// is the worst outcome available here.
function replaceStages(store, body, actor) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.stages)) {
    throw new UsageError('stages must be an object with a "stages" array.');
  }
  const next = { stages: body.stages, terminal: body.terminal ?? [], extra: body.extra ?? [] };
  return store.withLock(() => {
    const keep = new Set(stageIdsOf(next));
    const removed = stageIdsOf(readStages(store)).filter((id) => !keep.has(id));
    if (removed.length) {
      const items = store.readItems();
      for (const id of removed) {
        const count = items.filter((item) => item.stage === id).length;
        if (count) {
          throw new UsageError(`stage ${id} still holds ${count} item${count === 1 ? '' : 's'}; move them elsewhere before removing that stage.`);
        }
      }
      for (const stage of [...next.stages, ...next.extra]) {
        const dep = stage?.requires?.deps_at_least;
        if (dep !== undefined && removed.includes(dep)) {
          throw new UsageError(`stage ${stage.id} requires deps_at_least ${JSON.stringify(dep)}, so stage ${dep} cannot be removed; change that rule first.`);
        }
      }
    }
    const findings = validateStages(next);
    if (findings.length) {
      const error = new UsageError(`stages.json would not be valid:\n${findings.join('\n')}`);
      error.findings = findings;
      throw error;
    }
    writeFileSync(store.paths.stages, JSON.stringify(next, null, 2) + '\n');
    store.appendEvent({ type: 'stages', by: actor });
    return { ok: true, stages: stageIdsOf(next) };
  });
}

// Settings go through lib/settings.js and nothing else. `gw config` and this
// endpoint must accept and refuse exactly the same things, with the same
// wording: a board that saves a value the CLI would have rejected is a board
// that can write a config the rest of the tool refuses to read.
const NON_SETTING_FIELDS = new Set(['by', 'actor']);

function requestedSettings(body) {
  if (body?.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) return body.settings;
  if (typeof body?.key === 'string') return { [body.key]: body.value };
  return Object.fromEntries(Object.entries(body ?? {}).filter(([key]) => !NON_SETTING_FIELDS.has(key)));
}

function setSettings(store, body, actor) {
  const requested = requestedSettings(body);
  const keys = Object.keys(requested);
  if (!keys.length) throw new UsageError('no settings supplied; send { "key": ..., "value": ... } or { "settings": { ... } }.');
  return store.withLock(() => {
    const config = readConfig(store);
    const applied = {};
    for (const key of keys) {
      const raw = requested[key];
      // Glossary keys go through lib/settings.js's applyGlossaryEntry -- the
      // same function `gw config glossary.<field>.<code>` calls -- so the
      // board's Settings UI cannot write a glossary entry the CLI would have
      // refused, or in different words. See lib/settings.js for why this
      // shape does not live in SETTINGS_BY_KEY.
      const glossaryTarget = parseGlossaryKey(key);
      if (glossaryTarget) {
        const result = applyGlossaryEntry(config, glossaryTarget, Array.isArray(raw) ? raw.join(',') : raw);
        if (result.error) throw new UsageError(result.error);
        applied[key] = result.removed ? null : result.description;
        continue;
      }
      const setting = SETTINGS_BY_KEY.get(key);
      if (!setting) throw new UsageError(`unknown setting: ${key}\nrun \`gw config --list\` to see every settable key.`);
      const result = coerce(setting, Array.isArray(raw) ? raw.join(',') : raw);
      if (result.error) throw new UsageError(result.error);
      const choices = setting.choices ?? setting.choicesFrom?.(config) ?? null;
      if (choices?.length && !choices.includes(result.value)) {
        throw new UsageError(`${key} must be one of: ${choices.join(', ')}`);
      }
      setValue(config, key, result.value);
      applied[key] = result.value;
    }
    // Validation happens entirely before this line, so a rejected key leaves
    // config.json byte-identical rather than half-applied.
    store.writeConfig(config);
    store.appendEvent({ type: 'config', by: actor, keys });
    return { ok: true, config: applied };
  });
}

function errorResponse(res, error) {
  if (error instanceof RuleError) return sendJson(res, 409, { error: error.message, failures: error.failures });
  if (error instanceof UsageError || error?.status === 400) {
    return sendJson(res, 400, { error: error.message, ...(error.findings ? { findings: error.findings } : {}) });
  }
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

// HOW THE ENGLISH GETS INTO THE BOARD: viewer/board.html is a standalone
// document with no module loader, so it cannot import lib/gates/describe.js.
// The choice here is to resolve the descriptions on the Node side and ship
// them *in the payload the page already reads* -- the stages object -- rather
// than restating the sentences in the viewer. Two copies of this wording would
// drift, and a board that describes a rule it does not enforce is worse than
// one that prints JSON. `gw open` does the same thing into its inlined
// gw-stages block (lib/commands/open.js), so the offline snapshot and the live
// server show identical sentences from the one module.
function withGateDescriptions(stages) {
  const gates = {};
  for (const stage of stageList(stages)) gates[stage.id] = describeStage(stage, stages);
  return { ...stages, gates };
}

export function createServeServer({ store, shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8'), env = process.env, cwd = store.root, stderr = process.stderr, ghRun, clock, syncFn, allowedHosts = [] } = {}) {
  // Loopback always; anything else only because a caller passed --host and
  // accepted what that means. Default construction is unchanged.
  const allowed = new Set([...LOOPBACK, ...allowedHosts]);
  const sync = createSyncController({ store, env, stderr, ghRun, clock, syncFn });
  const registry = createRunRegistry({ store });
  const lifecycle = createRunLifecycle({ store, registry });
  const server = createServer(async (req, res) => {
    // Reads accept a missing Origin because ordinary same-origin page loads send
    // none. A supplied Origin still has to be loopback.
    if (!permitted(allowed, req.headers.host) || (req.headers.origin && !permitted(allowed, req.headers.origin))) {
      return send(res, 403, 'Gatewright serve accepts loopback requests only; use --host to bind an address it should also answer on.\n');
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'HEAD') return send(res, 200, '');
    if (req.method !== 'GET') {
      if (!writeAllowed(req, allowed)) return send(res, 403, 'Gatewright serve accepts guarded loopback writes only.\n');
      // Item writes travel as far as the board does. Rule changes do not.
      if ((url.pathname === '/api/stages' || url.pathname === '/api/config') && !adminAllowed(req)) {
        return send(res, 403, 'Gatewright serve changes stages and settings from loopback only; make this change on the machine running gw serve.\n');
      }
      try {
        const body = await readJson(req);
        const actor = requestActor(body, env);
        if (url.pathname === '/api/stages') return sendJson(res, 200, replaceStages(store, body, actor));
        if (url.pathname === '/api/config') return sendJson(res, 200, setSettings(store, body, actor));
        const command = commandRequest(url.pathname, body, actor);
        if (command) {
          await invoke(command.command, { ...command, store, root: store.root, actor, env, cwd });
          return sendJson(res, 200, { ok: true });
        }
        // Stopping a LIVE run, as distinct from cancelling a queued dispatch.
        // The README has always advertised per-run stop as one of three kill
        // switches, but the board could only ever cancel a dispatch that had
        // not started -- so an item whose agent was actually running could not
        // be stopped from the very screen showing it running.
        const stopRequest = url.pathname.match(/^\/api\/items\/([^/]+)\/stop$/);
        if (stopRequest) {
          // The async variant, because the grace period between the polite
          // stop and the forceful one is stop_timeout_s long -- 30 seconds by
          // default. The blocking form is right for `gw stop`, which must work
          // without an event loop, but here it would stop the board answering
          // anything at all, including the scheduler's own tick, for the whole
          // grace period.
          const stopped = await lifecycle.stopItemAsync(stopRequest[1]);
          return sendJson(res, 200, { ok: true, stopped: stopped.length });
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
      stages: withGateDescriptions(readStages(store)), config, sync: sync.status(), generatedAt: new Date().toISOString(),
      runs: registry.list().records.map((record) => ({ item: record.item, run: record.run, provider: record.provider, started: record.started })),
      scheduler: schedulerStatus(config, registry),
      // So the board can hide the stage and settings editors rather than
      // offering a control that answers 403.
      admin: { allowed: adminAllowed(req) },
    }), 'application/json; charset=utf-8');
  });
  server.on('close', sync.stop);
  return server;
}

export function listen(server, { port = 7777, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    // Dropping the startup listener must not leave the server bare: an 'error'
    // after a successful listen (a failing accept, a reset during shutdown) is
    // otherwise an uncaught exception that kills a long-running `gw serve`.
    const onListening = () => {
      server.off('error', onError);
      server.on('error', (error) => process.stderr.write(`gw serve: ${error.code || error.message}\n`));
      resolve(server.address());
    };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
  });
}
