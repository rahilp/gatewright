#!/usr/bin/env node
// Renders tmux `capture-pane -e` dumps (ANSI SGR text) as terminal-window PNGs.
//
// usage: node docs/img/render-terminal.mjs <outdir> <file.ansi>=<window title> ...
// Each <file.ansi> becomes <outdir>/<file>.png.
//
// Colours follow a common dark terminal: the Tango palette (GNOME Terminal's
// default, close to Terminal.app and Windows Terminal) with bold drawn in the
// bright colour, as iTerm2, Terminal.app and Windows Terminal do by default.
// That is what makes gw's bold white-on-cyan title bar read the way users see
// it; drawing bold white as plain #d3d7cf on a pale cyan washes it out.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withChrome } from './cdp.mjs';

const BG = '#1e1f22';
const FG = '#d3d7cf';
const NORMAL = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf'];
const BRIGHT = ['#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];
const cube = [0, 95, 135, 175, 215, 255];
const c256 = (n) => n < 8 ? NORMAL[n] : n < 16 ? BRIGHT[n - 8]
  : n < 232 ? `rgb(${cube[Math.floor((n - 16) / 36)]},${cube[Math.floor((n - 16) / 6) % 6]},${cube[(n - 16) % 6]})`
  : `rgb(${8 + (n - 232) * 10},${8 + (n - 232) * 10},${8 + (n - 232) * 10})`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Every character outside ASCII is boxed to exactly one cell, so a glyph the
// font lacks (◆ ❯ ◉ ─ ↑) cannot come from a wider fallback font and push the
// rest of its row out of line with the rows around it.
const cells = (text) => esc(text).replace(/[^\x00-\x7f]/gu, (ch) => `<i>${ch}</i>`);

function toHtml(src) {
  let st = {};
  let out = '';
  let open = false;
  const span = () => {
    if (open) out += '</span>';
    let fg = st.fg ?? null;
    if (st.b && typeof fg === 'number' && fg < 8) fg += 8;
    let fgCss = fg === null ? null : typeof fg === 'number' ? c256(fg) : fg;
    let bgCss = st.bg === undefined || st.bg === null ? null : typeof st.bg === 'number' ? c256(st.bg) : st.bg;
    if (st.inv) [fgCss, bgCss] = [bgCss ?? BG, fgCss ?? FG];
    const css = [fgCss && `color:${fgCss}`, bgCss && `background:${bgCss}`, st.b && 'font-weight:700',
      st.dim && 'opacity:.62', st.u && 'text-decoration:underline'].filter(Boolean).join(';');
    out += `<span style="${css}">`;
    open = true;
  };
  for (const part of src.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { out += cells(part.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')); continue; }
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {};
      else if (c === 1) st.b = 1;
      else if (c === 2) st.dim = 1;
      else if (c === 4) st.u = 1;
      else if (c === 7) st.inv = 1;
      else if (c === 22) { st.b = 0; st.dim = 0; }
      else if (c === 24) st.u = 0;
      else if (c === 27) st.inv = 0;
      else if (c === 39) st.fg = null;
      else if (c === 49) st.bg = null;
      else if (c >= 30 && c <= 37) st.fg = c - 30;
      else if (c >= 40 && c <= 47) st.bg = c - 40;
      else if (c >= 90 && c <= 97) st.fg = c - 90 + 8;
      else if (c >= 100 && c <= 107) st.bg = c - 100 + 8;
      else if ((c === 38 || c === 48) && codes[i + 1] === 5) {
        if (c === 38) st.fg = codes[i + 2]; else st.bg = codes[i + 2];
        i += 2;
      } else if ((c === 38 || c === 48) && codes[i + 1] === 2) {
        const rgb = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        if (c === 38) st.fg = rgb; else st.bg = rgb;
        i += 4;
      }
    }
    span();
  }
  return out + (open ? '</span>' : '');
}

function page(ansi, title, cols) {
  return `<!doctype html><meta charset=utf-8><style>
  html, body { margin: 0; background: transparent; }
  body { padding: 36px; display: inline-block; }
  .win { background: ${BG}; border-radius: 10px; overflow: hidden; width: max-content;
    box-shadow: 0 0 0 1px rgba(255,255,255,.08), 0 14px 36px rgba(0,0,0,.40), 0 2px 8px rgba(0,0,0,.25); }
  .bar { background: #2b2d31; height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px;
    position: relative; border-bottom: 1px solid #17181a; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none;
    font: 500 13px/1 "Noto Sans", "Inter", system-ui, sans-serif; color: #a9adb3; }
  pre { margin: 0; padding: 14px 18px 16px; color: ${FG}; width: ${cols}ch;
    font: 15px/1.38 "JetBrainsMono NF", "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", monospace;
    font-variant-ligatures: none; }
  pre i { font-style: normal; display: inline-block; width: 1ch; line-height: 1; text-align: center; overflow: visible; }
</style><div class=win><div class=bar><span class=dot style="background:#ff5f57"></span><span class=dot style="background:#febc2e"></span><span class=dot style="background:#28c840"></span><span class=title>${esc(title)}</span></div><pre>${toHtml(ansi)}</pre></div>`;
}

const [outdirArg, ...jobs] = process.argv.slice(2);
if (!outdirArg || !jobs.length) {
  console.error('usage: render-terminal.mjs <outdir> <file.ansi>=<window title> ...');
  process.exit(2);
}
const outdir = resolve(outdirArg);
const work = mkdtempSync(join(tmpdir(), 'gw-term-'));
try {
  await withChrome(async ({ send, evaluate, viewport, navigate, shot }) => {
    // A transparent page, so the window's shadow sits on GitHub's light or
    // dark background alike.
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await viewport(1200, 1000, 2);
    for (const job of jobs) {
      const at = job.indexOf('=');
      const file = job.slice(0, at);
      const title = job.slice(at + 1);
      const ansi = readFileSync(file, 'utf8').replace(/\n+$/, '');
      const cols = Math.max(80, ...ansi.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map((l) => [...l].length));
      const html = join(work, `${basename(file, '.ansi')}.html`);
      writeFileSync(html, page(ansi, title, cols));
      await navigate(pathToFileURL(html).href, 700);
      const box = await evaluate(`(() => { const r = document.body.getBoundingClientRect(); return { x: 0, y: 0, width: Math.ceil(r.width), height: Math.ceil(r.height) }; })()`);
      await viewport(box.width, box.height, 2);
      await shot(join(outdir, `${basename(file, '.ansi')}.png`), box);
      await viewport(1200, 1000, 2);
    }
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}
