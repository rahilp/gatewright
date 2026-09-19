import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
].filter(Boolean);

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

async function withServer(fn, { items, events = [], config = {}, stages = STAGES, env } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gw-viewer-browser-'));
  const store = createStore(root); store.ensure();
  store.writeItems(items ?? [item(), item({ id: 'P1-02', title: 'Second unowned item' })]);
  for (const event of events) store.appendEvent(event);
  writeFileSync(store.paths.config, JSON.stringify({ version: 1, vocab: { phase: ['P1'], priority: ['P1'], type: ['feature'] }, runner: { paused: false }, ...config }));
  writeFileSync(store.paths.stages, JSON.stringify(stages));
  store.rebaselineDigest();
  const server = createServeServer({ store, ...(env ? { env } : {}) });
  const address = await listen(server, { port: 0 });
  try { await fn(`http://127.0.0.1:${address.port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const found = await loadPuppeteer();
// Browser coverage belongs in the normal test discovery so a machine that has
// the capability exercises it automatically. It remains zero-dependency for
// every other contributor and CI runner: Node reports a visible skip instead
// of failing a product test because an optional local browser is absent.
const BROWSER_SKIP = !found
  ? `needs puppeteer-core; set GW_PUPPETEER_CORE to its module path`
  : !found.executablePath
    ? 'needs Chromium; set GW_CHROMIUM or PUPPETEER_EXECUTABLE_PATH to its executable path'
    : false;

test('the table scrolls in its container and the Title column shows words at 390px', { skip: BROWSER_SKIP }, async () => {
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

// T-0107/T-0108/T-0109: an external agent's ownership is the useful live
// signal when the built-in runner is disabled. The runner's idle assertion and
// queue affordance must disappear, while a pre-existing dispatch remains
// cancellable; finished holds are intentionally excluded from the header.
test('runner-off cards show owners and queued state without pretending the built-in runner is the work', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  const stages = { ...STAGES, stages: STAGES.stages.map((stage) => stage.id === 'built' ? { ...stage, role: 'done' } : stage) };
  const cards = [
    item({ id: 'T-0107', stage: 'building', owner: 'agent:codex', title: 'Externally worked building item' }),
    item({ id: 'T-0108', owner: null, title: 'Unowned backlog item' }),
    item({ id: 'T-0109', owner: 'human:rahil', title: 'Queued item' }),
    item({ id: 'T-0110', stage: 'built', flag: 'needs-triage', owner: 'agent:old-run', title: 'Finished stale hold' }),
  ];
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 390, height: 844 });
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.waitForSelector('.card[data-id="T-0107"]');
      const mobile = await page.evaluate(() => {
        const card = (id) => document.querySelector(`.card[data-id="${id}"]`);
        const owner = card('T-0107')?.querySelector('.owner-chip');
        return {
          boardText: document.querySelector('#gw-view')?.textContent || '',
          ownerText: owner?.textContent || '', ownerTitle: owner?.getAttribute('title') || '',
          queuedText: card('T-0109')?.textContent || '',
          queuedCancel: Boolean(card('T-0109')?.querySelector('[data-stop="T-0109"]')),
          totals: document.querySelector('#gw-totals')?.textContent || '',
          cardWidth: Math.round(card('T-0107')?.getBoundingClientRect().width || 0),
        };
      });
      assert.doesNotMatch(mobile.boardText, /no agent run|Queue for an agent/, mobile.boardText);
      assert.equal(mobile.ownerText, 'agent · codex');
      assert.equal(mobile.ownerTitle, 'agent:codex');
      assert.match(mobile.queuedText, /queued/);
      assert.equal(mobile.queuedCancel, true, 'an already queued dispatch still has its Cancel control');
      assert.match(mobile.totals, /4 items/);
      assert.match(mobile.totals, /3 open/);
      assert.match(mobile.totals, /0 flagged/, 'the finished needs-triage hold is not actionable header work');
      assert.ok(mobile.cardWidth > 0 && mobile.cardWidth <= 390, `the owner chip fits the phone card (${mobile.cardWidth}px)`);

      await page.setViewport({ width: 1280, height: 800 });
      assert.equal(await page.$eval('.card[data-id="T-0107"]', (el) => Math.round(el.getBoundingClientRect().width) > 0), true, 'the same card remains visible at desktop width');
    } finally { await browser.close(); }
  }, { items: cards, events: [{ type: 'dispatch', item: 'T-0109', by: 'human:rahil' }], stages });
});

test('runner-on cards restore the built-in runner status and Play control', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.waitForSelector('.card[data-id="P1-01"]');
      const state = await page.$eval('.card[data-id="P1-01"]', (card) => ({ text: card.textContent || '', play: card.querySelector('[data-play="P1-01"]')?.textContent }));
      assert.match(state.text, /no agent run/);
      assert.equal(state.play, 'Play');
    } finally { await browser.close(); }
  }, { config: { runner: { enabled: true, provider: 'stub', providers: { stub: { cmd: ['stub'] } }, paused: false } } });
});

// T-0090 — a failed drawer write is an outcome a human must be able to read,
// not transient paint that the two-second poll erases. Exercise the actual
// server, page event handler, and poll loop rather than calling showPanelError
// in isolation.
test('T-0090: a triage self-approval refusal survives three browser poll cycles', { skip: BROWSER_SKIP }, async (t) => {
  const { mod: puppeteer, executablePath } = found;
  const held = item({ flag: 'needs-triage', created_by: 'agent:tester', owner: null });
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.waitForSelector('.card[data-id="P1-01"]');
      await page.click('.card[data-id="P1-01"]');
      await page.waitForSelector('#panel-triage-approve');
      const started = Date.now();
      await page.click('#panel-triage-approve');
      await page.waitForFunction(() => document.querySelector('#panel-error')?.textContent.includes('different agent'));
      const samples = [];
      for (let cycle = 1; cycle <= 3; cycle += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2100));
        samples.push(await page.$eval('#panel-error', (el) => el.textContent.trim()));
      }
      const elapsed = Date.now() - started;
      assert.ok(samples.every((text) => /different agent/.test(text)), `refusal vanished during polling: ${JSON.stringify(samples)}`);
      assert.ok(elapsed >= 6300, `measured only ${elapsed}ms across three polls`);
      t.diagnostic(`triage refusal remained in #panel-error for ${elapsed}ms across three 2.1s samples`);
    } finally { await browser.close(); }
  }, { items: [held], env: { ...process.env, GW_ACTOR: 'agent:tester' } });
});

// T-0099: these have to be real browser keystrokes. A structural test can
// prove a document handler exists while a closed drawer still retains all of
// its interactive DOM and looks open to a user or accessibility tooling.
test('T-0099: Escape clears both drawers and Enter activates the focused Close button', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.click('.card[data-id="P1-01"]');
      assert.equal(await page.$eval('#gw-panel', (el) => el.innerHTML.length > 0), true, 'the item drawer opened');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'panel-close', 'the item Close button is focused');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#gw-panel', (el) => el.innerHTML.length), 0, 'Enter emptied the item drawer');

      await page.click('.card[data-id="P1-01"]');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#gw-panel', (el) => el.innerHTML.length), 0, 'Escape emptied the item drawer');

      await page.click('#f-new');
      await page.waitForSelector('#create-form');
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#gw-panel', (el) => el.innerHTML.length), 0, 'Escape emptied the create dialog');
    } finally { await browser.close(); }
  });
});

test('T-0100: an owner can release from the drawer, while a non-owner is not offered Release', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  const owned = item({ owner: 'human:rahil' });
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.click('.card[data-id="P1-01"]');
      await page.waitForSelector('#panel-release');
      await page.click('#panel-release');
      await page.waitForFunction(() => !document.querySelector('#panel-release'));
      const state = await (await fetch(url + '/api/state')).json();
      assert.equal(state.items[0].owner, null, 'drawer Release used the server release path');
    } finally { await browser.close(); }
  }, { items: [owned], env: { ...process.env, GW_ACTOR: 'human:rahil' } });

  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle0' });
      await page.click('[data-view="board"]');
      await page.click('.card[data-id="P1-01"]');
      assert.equal(await page.$('#panel-release'), null, 'a non-owner sees no Release control');
    } finally { await browser.close(); }
  }, { items: [owned], env: { ...process.env, GW_ACTOR: 'human:someone-else' } });
});

// T-0117..T-0120: the defects the README screenshots exposed, measured where
// they happened -- in a laid-out page at a laptop width and a phone width.
const SCREENSHOT_STAGES = {
  stages: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'building', label: 'Building', requires: { owner: true } },
    { id: 'built', label: 'Built', requires: { evidence_min: 1 } },
    { id: 'in_review', label: 'In review', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
    { id: 'reviewed', label: 'Reviewed' },
    { id: 'merged', label: 'Merged', requires: { deps_at_least: 'merged' } },
    { id: 'verified', label: 'Verified', requires: { evidence_min: 2 } },
  ],
  terminal: ['verified'],
  extra: [{ id: 'dropped', label: 'Dropped' }, { id: 'paused', label: 'Paused' }],
};
const SCREENSHOT_ITEMS = [
  item({ id: 'T-0002', title: 'HTTP check worker', stage: 'backlog', owner: 'human:jonas' }),
  item({ id: 'T-0003', title: 'Public status page shows current incidents', stage: 'in_review', owner: 'human:maya', evidence: ['abc1234'] }),
  item({ id: 'T-0005', title: 'Email an alert when a check fails twice in a row', stage: 'built', owner: 'agent:claude', evidence: ['9ab61fe'] }),
  item({ id: 'T-0008', title: 'Slack alerts through an incoming webhook', stage: 'building', owner: 'human:jonas', deps: ['T-0002'] }),
  item({ id: 'T-0015', title: 'Checks page is slow with 300+ checks', stage: 'backlog', owner: null, flag: 'unclassified', type: null, phase: null, created_by: 'human:maya-with-a-long-actor-name' }),
  item({ id: 'T-0010', title: 'Self-hosting guide', stage: 'verified', owner: 'human:maya', evidence: ['a', 'b'] }),
];

test('T-0117..T-0120: overview rows, board columns, stage strip and bars at 1440px and 390px', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      for (const width of [1440, 390]) {
        await page.setViewport({ width, height: 900 });
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.click('[data-view="overview"]');
        await page.waitForSelector('.brief-row');
        const overview = await page.evaluate(() => {
          document.querySelector('.overview-distribution').open = true;
          const escapes = [];
          for (const card of document.querySelectorAll('.overview-card')) {
            const box = card.getBoundingClientRect();
            for (const el of card.querySelectorAll('span, p, button')) {
              const r = el.getBoundingClientRect();
              if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 0.5)) escapes.push(el.textContent.slice(0, 50));
            }
          }
          const titleWidths = [...document.querySelectorAll('.brief-row span:first-child')].map((s) => s.getBoundingClientRect().width);
          const barStarts = [...document.querySelectorAll('.dist-rows')].map((rows) =>
            new Set([...rows.querySelectorAll('.bar')].map((bar) => Math.round(bar.getBoundingClientRect().left))).size);
          const blocked = [...document.querySelectorAll('.brief-row')].find((row) => row.dataset.id === 'T-0008');
          return { docWidth: document.documentElement.scrollWidth, escapes, minTitle: Math.min(...titleWidths), barStarts, blocked: blocked?.textContent || '' };
        });
        assert.equal(overview.docWidth, width, `the Overview never scrolls sideways at ${width}px`);
        assert.deepEqual(overview.escapes, [], `nothing paints past its Overview card at ${width}px`);
        assert.ok(overview.minTitle >= 150, `every row title keeps most of a title at ${width}px (narrowest ${Math.round(overview.minTitle)}px; was ~30px)`);
        assert.ok(overview.barStarts.length >= 3 && overview.barStarts.every((n) => n === 1), `every bar in a distribution card starts at one x (${overview.barStarts})`);
        assert.match(overview.blocked, /waits on T-0002/, 'the Blocked row names its dependency');

        await page.click('[data-view="board"]');
        await page.waitForSelector('.card[data-id="T-0008"]');
        const board = await page.evaluate(() => {
          const column = (id) => document.querySelector(`.column[data-stage="${id}"]`);
          column('dropped').scrollIntoView({ block: 'nearest', inline: 'nearest' });
          const dropped = column('dropped').getBoundingClientRect();
          const middle = document.elementFromPoint(dropped.left + dropped.width / 2, dropped.top + dropped.height * 0.75);
          return {
            chip: document.querySelector('.card[data-id="T-0008"] .tag.dep-wait')?.textContent || '',
            freeChip: Boolean(document.querySelector('.card[data-id="T-0002"] .tag.dep-wait')),
            toggles: [...document.querySelectorAll('[data-toggle-stage]')].map((b) => b.dataset.toggleStage),
            droppedFolded: column('dropped').classList.contains('column-folded'),
            pausedFolded: column('paused').classList.contains('column-folded'),
            reviewedFolded: column('reviewed').classList.contains('column-folded'),
            droppedWidth: dropped.width, droppedHeight: dropped.height,
            dropTarget: middle?.closest('.column')?.dataset.stage,
            board: document.getElementById('board').scrollWidth,
            docWidth: document.documentElement.scrollWidth,
          };
        });
        assert.equal(board.chip, 'waits on T-0002', 'a dependency-blocked card says what it waits on');
        assert.equal(board.freeChip, false, 'an unblocked card has no such chip');
        assert.deepEqual(board.toggles, [], 'no "Show all" where nothing is hidden (empty Dropped, one-item Verified)');
        assert.equal(board.droppedFolded && board.pausedFolded, true, 'empty side columns fold');
        assert.equal(board.reviewedFolded, false, 'an empty working stage does not');
        assert.ok(board.droppedWidth < 50, `a folded column is a narrow strip (${board.droppedWidth}px)`);
        assert.ok(board.droppedHeight > 150, 'but still the full lane height');
        assert.equal(board.dropTarget, 'dropped', 'the strip is still the Dropped column under the pointer, so a drop lands there');
        assert.equal(board.docWidth, width, 'the page itself never grows sideways; the board scrolls in its own container');
        if (width === 1440) assert.ok(board.board <= 1440 - 40, `nine columns fit a 1440px screen (${board.board}px)`);

        await page.click('.card[data-id="T-0005"]');
        await page.waitForFunction(() => document.querySelector('#gw-panel .stage-button-wrap [data-move="reviewed"]')
          && !/checking transition rules/.test(document.querySelector('#gw-panel').textContent));
        const strip = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#gw-panel .stage-button-wrap')].map((wrap) =>
          [wrap.querySelector('[data-move]').dataset.move, wrap.innerText])));
        assert.match(strip.in_review, /pull request/, 'the next stage names its own unmet rule');
        for (const skip of ['reviewed', 'merged', 'verified']) {
          assert.doesNotMatch(strip[skip], /pull request/, `${skip} does not repeat In review's rule`);
          assert.doesNotMatch(strip[skip], /(^|\n)[a-z]/, `${skip}'s notes start as sentences: ${JSON.stringify(strip[skip])}`);
          assert.match(strip[skip], /This gate checks:/);
        }
        assert.match(strip.merged, /Every dependency must have reached Merged/, 'each skip shows its own gate');
        assert.match(strip.verified, /at least two new pieces of evidence/);
        assert.match(strip.reviewed, /Nothing is checked here/);
        await page.keyboard.press('Escape');
      }
    } finally { await browser.close(); }
  }, { items: SCREENSHOT_ITEMS, stages: SCREENSHOT_STAGES });
});

// T-0124 / T-0125 in a laid-out page: the board the column bug was reported
// on (278 items, nearly all finished, some dropped) at 2000px, in both colour
// schemes. The widths, the untruncated counts and the cool surfaces are read
// off the rendered page, not the stylesheet.
const TRUNK_STAGES = {
  stages: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'building', label: 'Building', requires: { owner: true } },
    { id: 'built', label: 'Built', requires: { evidence_min: 1 }, role: 'done' },
  ],
  terminal: ['dropped'],
  extra: [{ id: 'dropped', label: 'Dropped' }, { id: 'paused', label: 'Paused' }],
};
const LARGE_ITEMS = Array.from({ length: 278 }, (_, i) => {
  const n = i + 1;
  const stage = n <= 263 ? 'built' : n <= 277 ? 'dropped' : 'paused';
  return item({ id: `T-${String(n).padStart(4, '0')}`, title: `Finished item ${n}`, stage, evidence: stage === 'built' ? ['abc1234'] : [],
    updated: new Date(Date.UTC(2026, 5, 1) + n * 3600e3).toISOString() });
});

test('T-0124/T-0125: a 278-item board at 2000px -- widths, counts and a cool palette in both schemes', { skip: BROWSER_SKIP }, async () => {
  const { mod: puppeteer, executablePath } = found;
  await withServer(async (url) => {
    const browser = await puppeteer.launch({ executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 2000, height: 1000 });
      for (const scheme of ['light', 'dark']) {
        await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
        await page.goto(url, { waitUntil: 'networkidle0' });
        await page.click('[data-view="board"]');
        await page.waitForSelector('.column[data-stage="built"] .card');
        const board = await page.evaluate(() => {
          const rgb = (css) => (css.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
          const columns = [...document.querySelectorAll('.column')].map((c) => {
            const box = c.getBoundingClientRect();
            const main = c.querySelector('.column-head-main');
            const count = c.querySelector('.count');
            const toggle = c.querySelector('.column-toggle');
            const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= box.left - 0.5 && r.right <= box.right + 0.5; };
            return {
              stage: c.dataset.stage, width: box.width, height: box.height, cards: c.querySelectorAll('.card').length,
              count: count.textContent, countWhole: count.scrollWidth <= count.clientWidth + 0.5 && inside(count),
              headClipped: !c.classList.contains('column-folded') && main.scrollWidth > main.clientWidth + 0.5,
              toggleWhole: !toggle || (toggle.scrollWidth <= toggle.clientWidth + 0.5 && inside(toggle)),
              empty: c.classList.contains('column-empty'), folded: c.classList.contains('column-folded'),
            };
          });
          const style = (sel) => getComputedStyle(document.querySelector(sel));
          return {
            columns,
            surfaces: {
              bgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
              card: rgb(style('.card').backgroundColor),
              header: rgb(style('#gw-header').backgroundColor),
              tabs: rgb(style('#gw-tabs').backgroundColor),
              banner: rgb(style('#gw-pause-banner').backgroundColor),
            },
          };
        });
        const by = Object.fromEntries(board.columns.map((c) => [c.stage, c]));
        assert.equal(by.built.count, '263');
        assert.equal(by.dropped.count, '14');
        for (const c of board.columns) {
          assert.ok(c.countWhole, `${scheme}: the ${c.stage} count "${c.count}" is shown whole`);
          assert.ok(c.toggleWhole, `${scheme}: the ${c.stage} "Show all" is not clipped`);
          assert.equal(c.headClipped, false, `${scheme}: the ${c.stage} header is not clipped`);
        }
        const withCards = board.columns.filter((c) => c.cards > 0);
        const empties = board.columns.filter((c) => c.cards === 0 && !c.folded);
        assert.deepEqual(empties.map((c) => c.stage), ['backlog', 'building'], 'the empty working stages stay open lanes');
        assert.ok(empties.every((c) => c.empty), 'and are marked as empty');
        const narrowest = Math.min(...withCards.map((c) => c.width));
        const widestEmpty = Math.max(...empties.map((c) => c.width));
        assert.ok(narrowest >= widestEmpty, `${scheme}: every column with cards (narrowest ${narrowest}px) is at least as wide as every empty one (widest ${widestEmpty}px)`);
        assert.ok(by.built.width > 200 && by.dropped.width > 200, `Built and Dropped are no longer squeezed (${by.built.width}px, ${by.dropped.width}px; were 160px)`);
        for (const c of empties) {
          assert.ok(c.width >= 144, `${c.stage} is still a usable drop target (${c.width}px)`);
          assert.ok(c.height > 300, `${c.stage} is still a full-height lane`);
        }

        // Every surface is cool: blue >= red. Light is white where it is a
        // surface; dark keeps its dark look.
        const bg = board.surfaces.bgVar.slice(1).match(/../g).map((h) => parseInt(h, 16));
        assert.ok(bg[2] >= bg[0], `${scheme}: --bg ${board.surfaces.bgVar} is warm`);
        for (const [name, [r, , b]] of Object.entries(board.surfaces).filter(([name]) => name !== 'bgVar')) {
          assert.ok(b >= r, `${scheme}: ${name} rgb(${r}, _, ${b}) is warm`);
        }
        if (scheme === 'light') {
          assert.deepEqual(board.surfaces.card, [255, 255, 255], 'a light card is pure white');
          assert.deepEqual(board.surfaces.tabs, [255, 255, 255], 'the tab bar is pure white');
          assert.deepEqual(board.surfaces.banner, [255, 255, 255], 'the scheduler-off banner is amber on white, not a beige fill');
          assert.equal(board.surfaces.bgVar, '#eef2f7');
        } else {
          assert.ok(board.surfaces.tabs.every((v) => v < 60), 'dark keeps its dark surfaces');
        }
      }
    } finally { await browser.close(); }
  }, { items: LARGE_ITEMS, stages: TRUNK_STAGES });
});
