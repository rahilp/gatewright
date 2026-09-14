import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectData } from '../lib/viewer/inject.js';

const SHELL = '<!DOCTYPE html>\n<html><head></head><body><div id="app"></div>\n</body></html>\n';

const data = (over = {}) => ({
  items: [{ id: 'P1-01', title: 'Repo scaffold' }],
  events: [{ ts: '2026-09-14T10:00:00Z', type: 'add', item: 'P1-01' }],
  stages: { stages: [{ id: 'backlog', label: 'Backlog' }] },
  config: { version: 1 },
  generatedAt: '2026-09-14T12:00:00Z',
  ...over,
});

function extractBlock(html, id) {
  const re = new RegExp(`<script type="application\\/json" id="${id}">([\\s\\S]*?)<\\/script>`);
  const match = html.match(re);
  assert.ok(match, `expected a ${id} block in the output`);
  return JSON.parse(match[1]);
}

test('injects all four data blocks immediately before </body>', () => {
  const out = injectData(SHELL, data());
  assert.match(out, /<script type="application\/json" id="gw-items">.*<\/script>\s*<script type="application\/json" id="gw-events">.*<\/script>\s*<script type="application\/json" id="gw-stages">.*<\/script>\s*<script type="application\/json" id="gw-config">.*<\/script>\s*<\/body>/s);
});

test('round-trips items, events, and stages through JSON.parse', () => {
  const out = injectData(SHELL, data());
  assert.deepEqual(extractBlock(out, 'gw-items'), data().items);
  assert.deepEqual(extractBlock(out, 'gw-events'), data().events);
  assert.deepEqual(extractBlock(out, 'gw-stages'), data().stages);
});

test('stamps generatedAt so the page can show snapshot time', () => {
  const out = injectData(SHELL, data());
  const config = extractBlock(out, 'gw-config');
  assert.equal(config.generatedAt, '2026-09-14T12:00:00Z');
});

test('injecting twice replaces the blocks instead of duplicating them', () => {
  const once = injectData(SHELL, data());
  const twice = injectData(once, data({ items: [{ id: 'P1-02', title: 'second pass' }] }));
  const matches = twice.match(/id="gw-items"/g);
  assert.equal(matches.length, 1, 'must not accumulate duplicate blocks across repeated injection');
  assert.deepEqual(extractBlock(twice, 'gw-items'), [{ id: 'P1-02', title: 'second pass' }]);
});

test('a title containing </script> cannot break out of the JSON block', () => {
  const evil = '</script><script>window.pwned = true;</script>';
  const out = injectData(SHELL, data({ items: [{ id: 'P1-01', title: evil }] }));
  // The raw closing sequence must never appear unescaped inside the injected payload.
  assert.ok(!out.includes('</script><script>window.pwned'), 'the </script> sequence must be escaped so the HTML parser never sees it as a real closing tag');
  const items = extractBlock(out, 'gw-items');
  assert.equal(items[0].title, evil, 'JSON.parse must still recover the original, unescaped string');
});

test('a title containing <!-- cannot break out via a comment', () => {
  const evil = 'weird <!-- title';
  const out = injectData(SHELL, data({ items: [{ id: 'P1-01', title: evil }] }));
  assert.ok(!out.includes('<!-- title'), 'a literal <!-- must be escaped inside the injected payload');
  const items = extractBlock(out, 'gw-items');
  assert.equal(items[0].title, evil);
});

test('U+2028 and U+2029 are escaped so the JSON stays valid inside a script element', () => {
  const evil = 'line sep and  para';
  const out = injectData(SHELL, data({ items: [{ id: 'P1-01', title: evil }] }));
  assert.ok(!out.includes(' ') && !out.includes(' '), 'raw U+2028/U+2029 must not appear in the output');
  const items = extractBlock(out, 'gw-items');
  assert.equal(items[0].title, evil);
});
