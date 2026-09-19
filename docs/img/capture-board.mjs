#!/usr/bin/env node
// Captures the README screenshots of the live board from a running
// `gw serve` of the demo board (demo-board.sh).
//
// usage: node docs/img/capture-board.mjs [url] [outdir]
//   url     default http://127.0.0.1:7791/   (never the owner's :7777 board)
//   outdir  default: this directory
// GW_SHOT_ITEM=<id> picks the item whose detail panel is shown (default T-0005).
//
// docs/img/regenerate.sh runs this with the demo board and optimises the PNGs.
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withChrome, sleep } from './cdp.mjs';

const url = process.argv[2] ?? 'http://127.0.0.1:7791/';
const outdir = resolve(process.argv[3] ?? dirname(fileURLToPath(import.meta.url)));
const detailId = process.env.GW_SHOT_ITEM ?? 'T-0005';

// The board polls every two seconds and re-renders, which closes an opened
// <details> and resets the panel's scroll. pin() re-applies a DOM tweak every
// 30 ms until the next pin, so the shot sees the state that was asked for.
const pin = (body) => `clearInterval(window.__pin); window.__pin = setInterval(() => { ${body} }, 30); true`;
const tab = (label) => `[...document.querySelectorAll('button, a, [role=tab]')]
  .find((e) => e.textContent.trim() === ${JSON.stringify(label)}).click(); true`;

await withChrome(async ({ evaluate, viewport, navigate, shot }) => {
  await viewport(1440, 900, 2);
  await navigate(url);

  // Overview: what is in flight, blocked, held and next, with the
  // distribution open so the page is not half empty.
  await evaluate(tab('Overview'));
  await evaluate(pin(`const d = document.querySelector('.overview-distribution'); if (d) d.open = true;`));
  await sleep(400);
  const overviewHeight = await evaluate(`(() => {
    const d = document.querySelector('.overview-distribution');
    return Math.ceil(d.getBoundingClientRect().bottom + 28);
  })()`);
  await viewport(1440, overviewHeight, 2);
  await shot(join(outdir, 'overview.png'));

  // Board: wide enough for every column, so none is cut off by a scrollbar.
  await evaluate(`clearInterval(window.__pin); true`);
  await viewport(1440, 900, 2);
  await evaluate(tab('Board'));
  await sleep(400);
  const boardWidth = await evaluate(`(() => {
    const cols = [...document.querySelectorAll('.column')];
    const right = Math.max(...cols.map((c) => c.getBoundingClientRect().right));
    return Math.ceil(right + cols[0].getBoundingClientRect().left);
  })()`);
  await viewport(boardWidth, 860, 1.5);
  await shot(join(outdir, 'board.png'));

  // Stages & rules, with the Built gate's editor open to show the form and
  // the English read-back; cut just below that stage.
  await viewport(1440, 1200, 2);
  await evaluate(tab('Stages & rules'));
  await sleep(400);
  const editor = `[...document.querySelectorAll('details.stage-editor')][2]`;
  await evaluate(pin(`const d = ${editor}; if (d) d.open = true;`));
  await sleep(400);
  const stagesBottom = await evaluate(`Math.ceil(${editor}.parentElement.getBoundingClientRect().bottom + 6)`);
  await viewport(1440, stagesBottom, 2);
  await shot(join(outdir, 'stages.png'));

  // One item's detail panel over the table, scrolled to its evidence, fields
  // (with the dependency) and notes.
  await evaluate(`clearInterval(window.__pin); true`);
  await viewport(1440, 1000, 2);
  await evaluate(tab('Table'));
  await sleep(400);
  await evaluate(`document.querySelector('[data-id="${detailId}"]').click(); true`);
  await sleep(600);
  await evaluate(pin(`const panel = document.getElementById('gw-panel');
    const heading = [...panel.querySelectorAll('h2, h3')].find((h) => h.textContent.trim() === 'Evidence');
    if (heading) panel.scrollTop = heading.offsetTop - 16;`));
  await sleep(400);
  // End just below the notes rather than on a sliver of the note form.
  const notesBottom = await evaluate(`Math.ceil(document.querySelector('#gw-panel .notes-body').getBoundingClientRect().bottom + 6)`);
  await shot(join(outdir, 'item-detail.png'), { x: 0, y: 0, width: 1440, height: Math.min(notesBottom, 1000) });
});
