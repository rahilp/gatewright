import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

const item = (over = {}) => ({
  id: 'P1-01', title: 'Repo scaffold', phase: 'P1', priority: 'P1', gate: 'G0',
  type: 'feature', stage: 'backlog', flag: null, owner: null, scope: '',
  deps: [], evidence: [], notes: '', refs: [], parent: null,
  created_by: 'human', gh: null,
  created: '2026-09-14T10:00:00Z', updated: '2026-09-14T10:00:00Z', ...over,
});

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), 'gw-open-'));
  const store = createStore(root);
  store.ensure();
  return { root, store };
}

function extractBlock(html, id) {
  const re = new RegExp(`<script type="application\\/json" id="${id}">([\\s\\S]*?)<\\/script>`);
  const match = html.match(re);
  assert.ok(match, `expected a ${id} block in the written board.html`);
  return JSON.parse(match[1]);
}

test('gw open --no-browser writes .gatewright/board.html with the injected data', () => {
  const { root, store } = freshRoot();
  store.writeItems([item(), item({ id: 'P1-02', title: 'store.js' })]);
  store.appendEvent({ type: 'add', item: 'P1-01', by: 'human:rahil' });

  const out = execFileSync(process.execPath, [BIN, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /board\.html/);

  const html = readFileSync(store.paths.board, 'utf8');
  const items = extractBlock(html, 'gw-items');
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'P1-01');

  const events = extractBlock(html, 'gw-events');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'add');

  const stages = extractBlock(html, 'gw-stages');
  assert.ok(Array.isArray(stages.stages) && stages.stages.length > 0);

  const config = extractBlock(html, 'gw-config');
  assert.ok(config.generatedAt, 'config block should carry the snapshot timestamp');
});

test('gw open exits 0 and prints the board path on stdout', () => {
  const { root, store } = freshRoot();
  store.writeItems([item()]);
  const out = execFileSync(process.execPath, [BIN, 'open', '--no-browser'], { cwd: root, encoding: 'utf8' });
  assert.match(out.trim(), /board\.html$/);
});
