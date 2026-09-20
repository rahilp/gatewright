import { spawn } from 'node:child_process';
import { hostname, networkInterfaces } from 'node:os';
import { UsageError } from '../cli/errors.js';
import { createServeServer, listen } from '../serve/server.js';
import { createRunRegistry } from '../run/registry.js';
import { readConfig } from '../config.js';
import { createScheduler } from '../run/scheduler.js';

export const spec = { summary: 'serve the live board on loopback', flags: { port: { type: 'string' }, host: { type: 'string' }, open: { type: 'boolean' }, 'no-browser': { type: 'boolean' } }, positionals: [] };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// The board's API is not read-only and has no authentication: it can create
// and move items, and /api/items/<id>/dispatch starts an agent run. On
// loopback that is fine, because reaching it already means access to the
// machine. Off loopback it is a different proposition, so say plainly what is
// being handed out rather than printing a URL and letting someone find out.
function reachableAddresses(port) {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}/`);
}

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  // "Best effort" has to include the failure that actually happens. A missing
  // opener -- xdg-open is absent on headless Linux, minimal containers and
  // plain WSL -- is reported by an asynchronous 'error' event, not a throw, so
  // the try/catch alone never saw it and the unhandled event took the whole
  // command down. The board is already on disk by this point; not launching a
  // browser is not a failure worth exiting over.
  try {
    const child = spawn(cmd, platform === 'win32' ? ['', '', url] : [url], { detached: true, stdio: 'ignore', shell: platform === 'win32' });
    child.once('error', () => {});
    child.unref();
  } catch { /* nothing left to do: the board is already written */ }
}

// T-0133(d) -- A TICK FAILURE MUST NEVER BE FATAL.
//
// `gw serve` is the supervisor for every live run on this board. If it dies,
// nothing is left watching them: no timeout enforcement, no reconciliation, no
// board. So the tick is the one call in this file that is not allowed to take
// the process down, whatever it does.
//
// A plain try/catch is not enough. With config.memory.enabled, tick() returns a
// Promise (the memory recall before a dispatch is asynchronous), so a worktree
// that cannot be created or a provider that is not executable arrives as a
// REJECTION, which a synchronous catch cannot see -- it became an unhandled
// rejection and killed serve outright. Both shapes are handled here, and the
// promise is returned so a caller that can wait (the tests) is able to.
export function superviseTick(tick, stderr) {
  const report = (error) => stderr.write(`gw serve: scheduler tick failed: ${error?.message ?? error}\n`);
  let result;
  try { result = tick(); } catch (error) { report(error); return undefined; }
  return typeof result?.then === 'function' ? result.then(() => {}, report) : undefined;
}

export async function run(ctx) {
  const requested = ctx.flags.port ?? '7777'; const port = Number(requested);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be an integer from 0 to 65535');
  const host = ctx.flags.host ?? '127.0.0.1';
  if (!host.trim()) throw new UsageError('--host must be an address to bind, for example 127.0.0.1 or 0.0.0.0');
  const exposed = !LOOPBACK.has(host);
  const reconciliation = createRunRegistry({ store: ctx.store }).reconcile();
  if (reconciliation.cleaned.length) ctx.stdout.write(`gw serve: reconciled ${reconciliation.cleaned.length} abandoned run(s).\n`);
  if (reconciliation.malformed.length) ctx.stderr.write(`gw serve: skipped ${reconciliation.malformed.length} malformed run record(s).\n`);
  const config = readConfig(ctx.store); const runnerConfig = config.runner ?? {};
  let schedulerTimer = null;
  if (runnerConfig.enabled) {
    if (!runnerConfig.provider || !runnerConfig.providers?.[runnerConfig.provider]) {
      ctx.stderr.write('gw serve: scheduler enabled but config.runner.provider is not configured; no runs will start.\n');
    } else {
      const scheduler = createScheduler({ store: ctx.store, stdout: ctx.stdout });
      const interval = Number.isFinite(runnerConfig.tick_s) && runnerConfig.tick_s > 0 ? runnerConfig.tick_s * 1000 : 5000;
      schedulerTimer = setInterval(() => { superviseTick(() => scheduler.tick(), ctx.stderr); }, interval);
    }
  }
  // Only the addresses this machine actually answers on, never a wildcard:
  // the Host/Origin allow-list is what keeps another site from driving the
  // board through someone's browser, so --host widens it by exactly this
  // machine's own addresses and no further.
  const allowedHosts = exposed
    ? [...new Set([host, hostname(), ...reachableAddresses(0).map((entry) => new URL(entry).hostname)])].filter((entry) => entry && entry !== '0.0.0.0')
    : [];
  const server = createServeServer({ store: ctx.store, env: ctx.env, cwd: ctx.cwd, stderr: ctx.stderr, ghRun: ctx.ghRun, allowedHosts });
  let address;
  try { address = await listen(server, { port, host }); } catch (error) {
    if (error?.code === 'EADDRNOTAVAIL') { ctx.stderr.write(`gw serve: cannot bind ${host}; it is not an address on this machine.\n`); return 3; }
    if (error?.code === 'EADDRINUSE') { ctx.stderr.write(`gw serve: port ${requested} is already in use (a stale gw serve is the likely cause).\n`); return 3; }
    throw error;
  }
  const url = `http://${LOOPBACK.has(host) ? '127.0.0.1' : host}:${address.port}/`;
  ctx.stdout.write(`Gatewright live board: ${url}\n`);
  if (exposed) {
    ctx.stderr.write(`\ngw serve: bound to ${host}, so this board is reachable by anything that can route to this machine.\n`);
    ctx.stderr.write('  The API has no authentication. Anyone who reaches it can create and move items,\n');
    ctx.stderr.write('  read run logs, and start an agent run on this machine via the board\'s Play control.\n');
    if (runnerConfig.enabled) ctx.stderr.write('  The runner is ENABLED, so dispatch will really spawn a provider process here.\n');
    else ctx.stderr.write('  The runner is disabled, so dispatch queues work rather than spawning anything.\n');
    for (const reachable of reachableAddresses(address.port)) ctx.stderr.write(`  Reachable at ${reachable}\n`);
    ctx.stderr.write('  Use --host 127.0.0.1 (the default) to keep it to this machine.\n\n');
  }
  if (ctx.flags.open && !ctx.flags['no-browser']) openInBrowser(url);
  await new Promise((resolve) => {
    const shutdown = () => { if (schedulerTimer) clearInterval(schedulerTimer); server.close(resolve); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  });
  ctx.stdout.write('Gatewright live board stopped.\n');
  return 0;
}
