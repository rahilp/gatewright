import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { readConfig, readStages } from '../config.js';
import { UsageError, RuleError } from '../cli/errors.js';
import { invoke } from './invoke.js';

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
  const match = pathname.match(/^\/api\/items\/([^/]+)(?:\/(move|note))?$/);
  if (pathname === '/api/items') {
    const { title, ...flags } = body;
    return { command: 'add', flags: { ...flags, by: actor }, positionals: [title] };
  }
  if (!match) return null;
  const [, id, action] = match;
  if (action === 'move') return { command: 'move', flags: { evidence: body.evidence ?? [], by: actor }, positionals: [id, body.to] };
  if (action === 'note') return { command: 'note', flags: { by: actor }, positionals: [id, body.text] };
  const { ...flags } = body;
  return { command: 'edit', flags: { ...flags, by: actor }, positionals: [id] };
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

export function createServeServer({ store, shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8'), env = process.env, cwd = store.root } = {}) {
  return createServer(async (req, res) => {
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
    if (url.pathname !== '/api/state') return send(res, 404, 'Not found.\n');
    const since = url.searchParams.get('since');
    const events = store.readEvents();
    return send(res, 200, JSON.stringify({
      items: store.readItems(), events: since ? events.filter((event) => String(event.ts) > since) : events,
      stages: readStages(store), config: readConfig(store), generatedAt: new Date().toISOString(),
    }), 'application/json; charset=utf-8');
  });
}

export function listen(server, { port = 7777, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
  });
}
