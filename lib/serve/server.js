import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readConfig, readStages } from '../config.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function loopback(value) {
  if (!value) return true;
  try { return LOOPBACK.has(new URL(value).hostname); } catch {
    return LOOPBACK.has(value.split(':')[0]) || value.startsWith('[::1]');
  }
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// Deliberately thin: this is a read-only HTTP view over the store. Future
// write endpoints must use the same command/store path as the CLI.
export function createServeServer({ store, shell = readFileSync(new URL('../../viewer/board.html', import.meta.url), 'utf8') }) {
  return createServer((req, res) => {
    if (!loopback(req.headers.host) || !loopback(req.headers.origin)) return send(res, 403, 'Gatewright serve accepts loopback requests only.\n');
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET') return send(res, 404, 'Not found.\n');
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
