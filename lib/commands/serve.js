import { spawn } from 'node:child_process';
import { UsageError } from '../cli/errors.js';
import { createServeServer, listen } from '../serve/server.js';
import { createRunRegistry } from '../run/registry.js';

export const spec = { summary: 'serve the live, read-only board on loopback', flags: { port: { type: 'string' }, open: { type: 'boolean' }, 'no-browser': { type: 'boolean' } }, positionals: [] };

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try { spawn(cmd, platform === 'win32' ? ['', '', url] : [url], { detached: true, stdio: 'ignore', shell: platform === 'win32' }).unref(); } catch { /* best effort */ }
}

export async function run(ctx) {
  const requested = ctx.flags.port ?? '7777'; const port = Number(requested);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be an integer from 0 to 65535');
  const reconciliation = createRunRegistry({ store: ctx.store }).reconcile();
  if (reconciliation.cleaned.length) ctx.stdout.write(`gw serve: reconciled ${reconciliation.cleaned.length} abandoned run(s).\n`);
  if (reconciliation.malformed.length) ctx.stderr.write(`gw serve: skipped ${reconciliation.malformed.length} malformed run record(s).\n`);
  const server = createServeServer({ store: ctx.store, env: ctx.env, cwd: ctx.cwd, stderr: ctx.stderr, ghRun: ctx.ghRun });
  let address;
  try { address = await listen(server, { port }); } catch (error) {
    if (error?.code === 'EADDRINUSE') { ctx.stderr.write(`gw serve: port ${requested} is already in use (a stale gw serve is the likely cause).\n`); return 3; }
    throw error;
  }
  const url = `http://127.0.0.1:${address.port}/`;
  ctx.stdout.write(`Gatewright live board: ${url}\n`);
  if (ctx.flags.open && !ctx.flags['no-browser']) openInBrowser(url);
  await new Promise((resolve) => {
    const shutdown = () => server.close(resolve);
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  });
  ctx.stdout.write('Gatewright live board stopped.\n');
  return 0;
}
