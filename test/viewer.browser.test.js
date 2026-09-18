import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createServeServer, listen } from '../lib/serve/server.js';

// These are the tests the structural pins cannot be: layout geometry and
// event timing in a real browser. They need puppeteer-core and a Chromium
// binary, neither of which this zero-dependency repo ships, so they run
// where those exist and SKIP (not fail) everywhere else.
//
// T-0027's test here asserts what the reopened defect actually was: the
// table container scrolls (scrollWidth > clientWidth) AND the Title column
// is wide enough to show words -- not merely that the document does not
// overflow. That document number was the original misverification: the
// table had crushed itself to fit it.

const PUPPETEER_PATHS = [
  process.env.GW_PUPPETEER_CORE,
  '/home/rahil/.local/share/mise/installs/node/26.7.0/lib/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js',
].filter(Boolean);

const CHROME_PATHS = [
  process.env.GW_CHROMIUM,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

async function loadPuppeteer() {
  for (const candidate of PUPPETEER_PATHS) {
    if (!existsSync(candidate)) continue;
    try { return { mod: await import(candidate), executablePath: CHROME_PATHS.find((p) => existsSync(p)) }; } catch { /* try the next */ }
  }
  return null;
}

const item = (overrides = {}) => ({
  id: 'P1-01', title: 'A backlog item with a long enough title to wrap', phase: 'P1', priority: 'P1', type: 'feature', stage: 'backlog',
  flag: null, owner: 'human:tester', scope: '', deps: [], evidence: [], notes: '', refs: [],
  parent: null, created_by: 'human:tester', gh: null, created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z',
  ...overrides,
});

const STAGES = {
  stages: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'building', label: 'Building', requires: { owner: true } },
    { id: 'built', label: 'Built', requires: { scope: true, evidence_min: 1 } },
  ],
  terminal: [],
  extra: [{ id: 'dropped', label: 'Dropped' }, { id: 'paused', label: 'Paused' }],
};

async function withServer(fn, { items } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-viewer-browser-'));
  const store = createStore(root); store.ensure();
  store.writeItems(items ?? [item(), item({ id: 'P1-02', title: 'Second unowned item' })]);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'] }, runner: { paused: false } }));
  writeFileSync(store.paths.stages, JSON.stringify(STAGES));
  store.rebaselineDigest();
  const server = createServeServer({ store });
  const address = await listen(server, { port: 0 });
  try { await fn(`http://127.0.0.1:${address.port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const found = await loadPuppeteer();

test('the table scrolls in its container and the Title column shows words at 390px', { skip: !found && `needs puppeteer-core (${platform})` }, async () => {
  const { mod: puppeteer, executablePath } = found;
  assert.ok(executablePath, 'a chromium binary is required');
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.evaluate(() => { const tab = [...document.querySelectorAll('[data-view]')].find((t) => t.dataset.view === 'table'); if (tab) tab.click(); });
      await new Promise((r) => setTimeout(r, 400));
      const measured = await page.evaluate(() => {
        const scroll = document.querySelector('.table-scroll');
        const titleCell = document.querySelector('table.gw-table tbody tr td.cell-title');
        const titleRange = titleCell?.firstChild && document.createRange();
        if (titleRange && titleCell?.firstChild) titleRange.selectNodeContents(titleCell.firstChild);
        return {
          hasScroll: !!scroll,
          scrollWidth: scroll?.scrollWidth ?? 0,
          clientWidth: scroll?.clientWidth ?? 0,
          docScrollWidth: document.documentElement.scrollWidth,
          titleCellWidth: titleCell ? Math.round(titleCell.getBoundingClientRect().width) : 0,
          // The failure mode was one character per line: the tallest line box
          // is one glyph. A readable title wraps at whole words, so its line
          // boxes are word-height, and words per line > 1.
          titleLineHeight: titleCell ? Math.round(parseFloat(getComputedStyle(titleCell).lineHeight)) : 0,
          titleCellHeight: titleCell ? Math.round(titleCell.getBoundingClientRect().height) : 0,
        };
      });
      assert.equal(measured.hasScroll, true, 'the table has its own scroll container');
      assert.ok(measured.scrollWidth > measured.clientWidth, `the container scrolls (scrollWidth ${measured.scrollWidth} > clientWidth ${measured.clientWidth})`);
      assert.equal(measured.docScrollWidth, 390, 'the page itself never grows sideways');
      assert.ok(measured.titleCellWidth >= 150, `the Title column is wide enough for words (${measured.titleCellWidth}px, was ~30px)`);
      assert.ok(measured.titleCellHeight < measured.titleLineHeight * 6, `the title wraps words, not characters (height ${measured.titleCellHeight} at ${measured.titleLineHeight}/line)`);
    } finally { await browser.close(); }
  });
});
