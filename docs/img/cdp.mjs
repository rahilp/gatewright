// A small headless-Chromium driver over the DevTools protocol, shared by the
// screenshot scripts in this directory. No dependencies: Node 22+ has
// WebSocket and fetch built in. CHROME=<path> picks the browser.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function withChrome(fn) {
  const profile = mkdtempSync(join(tmpdir(), 'gw-shots-chrome-'));
  const browser = spawn(process.env.CHROME ?? 'chromium', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });
  let ws;
  try {
    const portFile = join(profile, 'DevToolsActivePort');
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      if (existsSync(portFile)) port = readFileSync(portFile, 'utf8').split('\n')[0];
      if (!port) await sleep(100);
    }
    if (!port) throw new Error('chromium did not start (set CHROME=<path> to pick the browser)');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.fail(new Error(`${waiter.method}: ${msg.error.message}`));
      else waiter.ok(msg.result);
    };
    const send = (method, params = {}) => {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((ok, fail) => pending.set(id, { ok, fail, method }));
    };
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      return result.value;
    };
    const viewport = async (width, height, deviceScaleFactor) => {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
      await sleep(300);
    };
    const navigate = async (url, settle = 1500) => {
      await send('Page.navigate', { url });
      await sleep(settle);
    };
    // clip is in CSS pixels; the image comes out at the viewport's scale.
    const shot = async (file, clip) => {
      const params = { format: 'png', captureBeyondViewport: false };
      if (clip) params.clip = { ...clip, scale: 1 };
      const { data } = await send('Page.captureScreenshot', params);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`wrote ${file}`);
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    return await fn({ send, evaluate, viewport, navigate, shot });
  } finally {
    try { ws?.close(); } catch {}
    browser.kill();
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}
