import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { run } from '../lib/commands/note.js';
const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));
function repo() { const root = mkdtempSync(join(tmpdir(), 'gw-note-')); mkdirSync(join(root, '.gatewright')); writeFileSync(join(root, '.gatewright/config.json'), '{}'); const store = createStore(root); store.ensure(); store.writeItems([{ id: 'P1-01', notes: 'old' }]); return { root, store }; }
test('note preserves existing notes and records one note event', () => { const { store } = repo(); run({ store, actor: 'human:a', flags: {}, positionals: ['P1-01', 'new note'] }); assert.match(store.readItems()[0].notes, /^old\n\[[^\]]+\] new note$/); assert.equal(store.readEvents().at(-1).note, 'new note'); });
test('note works through the real binary', () => { const { root } = repo(); execFileSync(process.execPath, [BIN, 'note', 'P1-01', 'binary note'], { cwd: root }); });
