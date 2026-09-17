import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.js';
import { readConfig } from '../lib/config.js';
import { describeTerm, glossaryFor, GLOSSARY_FIELDS } from '../lib/glossary.js';
import { run as config } from '../lib/commands/config.js';
import { readTemplate } from '../lib/templates.js';

const BIN = fileURLToPath(new URL('../bin/gw.js', import.meta.url));

function board(overrides) {
  const root = mkdtempSync(join(tmpdir(), 'gw-glossary-'));
  const store = createStore(root);
  store.ensure();
  if (overrides !== undefined) writeFileSync(store.paths.config, JSON.stringify(overrides, null, 2));
  return { root, store };
}

function capture() {
  let text = '';
  return { write: (chunk) => { text += chunk; }, read: () => text };
}

const described = {
  vocab: { phase: ['P1', 'P9'], type: ['feature'] },
  glossary: { phase: { P1: 'The first working version.' }, type: { feature: 'New behaviour someone can see.' } },
};

test('a code with a glossary entry is described with exactly the text the board wrote', () => {
  assert.equal(describeTerm(described, 'phase', 'P1'), 'The first working version.');
  assert.equal(describeTerm(described, 'type', 'feature'), 'New behaviour someone can see.');
  assert.deepEqual(glossaryFor(described, 'phase'), { P1: 'The first working version.' });
});

test('a code with no glossary entry is null, so it renders exactly as it did before the glossary existed', () => {
  assert.equal(describeTerm(described, 'phase', 'P9'), null, 'a vocab code nobody described has no description');
  assert.equal(describeTerm(described, 'phase', 'P0'), null, 'a code that is not even in the vocab has no description');
  assert.equal(describeTerm(described, 'priority', 'P1'), null, 'a field with no glossary block at all has no descriptions');
  assert.equal(describeTerm(described, 'phase', ''), null, 'an empty value is not a lookup');
  assert.equal(describeTerm(described, 'phase', null), null, 'an unset field is not a lookup');
  assert.deepEqual(glossaryFor(described, 'priority'), {}, 'an absent field map reads as empty, never undefined');
});

test('a malformed glossary block degrades to no descriptions instead of throwing', () => {
  for (const broken of ['nonsense', 42, null, [], ['P1'], true]) {
    const cfg = { vocab: { phase: ['P1'] }, glossary: broken };
    assert.equal(describeTerm(cfg, 'phase', 'P1'), null, `glossary: ${JSON.stringify(broken)} means no descriptions, not a crash`);
    assert.deepEqual(glossaryFor(cfg, 'phase'), {}, `glossary: ${JSON.stringify(broken)} yields an empty map`);
  }
  for (const broken of ['nonsense', 7, ['P1'], null]) {
    const cfg = { glossary: { phase: broken } };
    assert.deepEqual(glossaryFor(cfg, 'phase'), {}, `glossary.phase = ${JSON.stringify(broken)} yields an empty map`);
  }
  // A map whose values are not usable sentences drops those entries only.
  assert.deepEqual(
    glossaryFor({ glossary: { phase: { P0: 12, P1: '', P2: '  ', P3: null, P4: 'Optional.' } } }, 'phase'),
    { P4: 'Optional.' },
    'only non-empty strings are descriptions; a number or a blank is dropped, not rendered',
  );
  assert.equal(describeTerm({}, 'phase', 'P1'), null, 'a config with no glossary key at all is fine');
  assert.equal(describeTerm(undefined, 'phase', 'P1'), null, 'no config at all is fine');
  assert.deepEqual(glossaryFor({ glossary: { phase: JSON.parse('{"__proto__": "hijacked"}') } }, 'phase'), {}, 'a __proto__ key is ignored rather than written through');
  assert.equal({}.hijacked, undefined, 'reading a glossary never pollutes Object.prototype');
});

test('the shipped templates/config.json describes every phase, priority and type it declares', () => {
  const shipped = JSON.parse(readTemplate('config.json'));
  for (const field of ['phase', 'priority', 'type']) {
    for (const code of shipped.vocab[field]) {
      const description = describeTerm(shipped, field, code);
      assert.equal(typeof description, 'string', `templates/config.json ships vocab.${field} "${code}" with no glossary entry`);
      assert.ok(description.length > 10, `the shipped description of ${field} "${code}" is too short to explain anything: ${JSON.stringify(description)}`);
    }
  }
});

test('the shipped glossary describes nothing that is not in the vocab, so the defaults cannot drift', () => {
  const shipped = JSON.parse(readTemplate('config.json'));
  for (const field of Object.keys(shipped.glossary)) {
    assert.ok(GLOSSARY_FIELDS.includes(field), `templates/config.json glossaries an unknown field: ${field}`);
    for (const code of Object.keys(shipped.glossary[field])) {
      assert.ok(shipped.vocab[field].includes(code), `templates/config.json describes ${field} "${code}", which is not in vocab.${field}`);
    }
  }
});

test('the shipped priority descriptions are exactly the wording a new user will read', () => {
  const shipped = JSON.parse(readTemplate('config.json'));
  assert.equal(describeTerm(shipped, 'priority', 'P0'), 'Drop other work for this.');
  assert.equal(describeTerm(shipped, 'priority', 'P1'), 'Do it in this phase.');
  assert.equal(describeTerm(shipped, 'priority', 'P2'), 'Do it when the P1 work is clear.');
  assert.equal(describeTerm(shipped, 'priority', 'P3'), 'Do it if there is room; fine to never do.');
});

test('gw config glossary.phase.P1 round-trips: set, read back, list, and remove', async () => {
  const { store } = board({ vocab: { phase: ['P1', 'P2'] } });

  const setOut = capture();
  assert.equal(await config({ store, positionals: ['glossary.phase.P1', 'The first working version.'], flags: {}, env: {}, stdout: setOut }), 0);
  assert.equal(
    JSON.parse(readFileSync(store.paths.config, 'utf8')).glossary.phase.P1,
    'The first working version.',
    'the description is written to config.glossary, leaving vocab.phase untouched',
  );
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')).vocab.phase, ['P1', 'P2']);
  assert.equal(setOut.read(), 'glossary.phase.P1 = "The first working version."\n');

  const readOut = capture();
  assert.equal(await config({ store, positionals: ['glossary.phase.P1'], flags: {}, env: {}, stdout: readOut }), 0);
  assert.equal(readOut.read(), '"The first working version."\n');

  const missingOut = capture();
  assert.equal(await config({ store, positionals: ['glossary.phase.P2'], flags: {}, env: {}, stdout: missingOut }), 0);
  assert.equal(missingOut.read(), '(unset)\n', 'a code with no description reads as unset, not as an error');

  const listOut = capture();
  assert.equal(await config({ store, positionals: [], flags: { list: true }, env: {}, stdout: listOut }), 0);
  assert.match(listOut.read(), /^vocab\.phase\s+\["P1","P2"\]$/m, '--list still prints the ordinary settings');
  assert.match(listOut.read(), /^glossary\.phase\.P1\s+"The first working version\."$/m, '--list prints the glossary entries that exist');

  const removeOut = capture();
  assert.equal(await config({ store, positionals: ['glossary.phase.P1', ''], flags: {}, env: {}, stdout: removeOut }), 0);
  assert.equal(removeOut.read(), 'glossary.phase.P1 removed\n');
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')).glossary.phase, {}, 'removing an entry leaves the rest of the glossary in place');
});

test('a glossary key naming an unknown vocab field is refused before anything is written', async () => {
  const { store } = board({ vocab: { phase: ['P1'] } });
  const before = readFileSync(store.paths.config, 'utf8');
  await assert.rejects(
    () => config({ store, positionals: ['glossary.colour.P1', 'nope'], flags: {}, env: {}, stdout: capture() }),
    /unknown vocab field: colour/,
  );
  assert.equal(readFileSync(store.paths.config, 'utf8'), before, 'a refused glossary write leaves the file byte-identical');
});

// P0-15 removed the item field `gate` entirely, so `glossary.gate.*` is now an
// unknown field like any other typo -- the same refusal `colour` gets above.
test('a glossary key naming the removed gate field is refused, same as any other unknown field', async () => {
  const { store } = board({ vocab: { phase: ['P1'] } });
  const before = readFileSync(store.paths.config, 'utf8');
  await assert.rejects(
    () => config({ store, positionals: ['glossary.gate.G0', 'nope'], flags: {}, env: {}, stdout: capture() }),
    /unknown vocab field: gate/,
  );
  assert.equal(readFileSync(store.paths.config, 'utf8'), before, 'a refused glossary write leaves the file byte-identical');
});

test('a glossary written over a malformed block replaces it rather than failing', async () => {
  const { store } = board({ vocab: { phase: ['P1'] }, glossary: 'nonsense' });
  const stdout = capture();
  assert.equal(await config({ store, positionals: ['glossary.phase.P1', 'Blocking.'], flags: {}, env: {}, stdout }), 0);
  assert.deepEqual(JSON.parse(readFileSync(store.paths.config, 'utf8')).glossary, { phase: { P1: 'Blocking.' } });
});

test('gw show explains the codes on an item, and says nothing about codes with no description', () => {
  const { root, store } = board();
  const item = { id: 'P1-01', title: 'Show me', phase: 'P1', type: 'feature', stage: 'building', flag: null, owner: null, deps: [], evidence: [], notes: '', parent: null };
  store.writeItems([item]);
  const shipped = readConfig(store);
  const text = execFileSync(process.execPath, [BIN, 'show', 'P1-01'], { cwd: root, encoding: 'utf8' });
  assert.match(text, /^phase: P1$/m, 'the raw code is still printed exactly as before');
  assert.match(text, new RegExp(`^  phase P1 — ${describeTerm(shipped, 'phase', 'P1')}$`, 'm'));
  assert.match(text, new RegExp(`^  type feature — ${describeTerm(shipped, 'type', 'feature')}$`, 'm'));

  const raw = JSON.parse(execFileSync(process.execPath, [BIN, 'show', 'P1-01', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.deepEqual(raw, item, '--json is still the raw item: help text is not data');

  writeFileSync(store.paths.config, JSON.stringify({ vocab: { phase: ['P1'] } }, null, 2));
  const bare = execFileSync(process.execPath, [BIN, 'show', 'P1-01'], { cwd: root, encoding: 'utf8' });
  assert.match(bare, /^phase: P1$/m);
  assert.equal(bare.includes('meaning:'), false, 'a board with no glossary gets no meaning section at all');
});

// P0-15: an item that still carries a legacy `gate` key on disk (never migrated,
// since `gw upgrade` promises data files stay byte-identical) must not crash or
// otherwise disrupt `gw show` -- it is simply an extra key nothing reads.
test('gw show tolerates a legacy gate key on disk without crashing or describing it', () => {
  const { root, store } = board();
  const item = { id: 'P1-01', title: 'Legacy item', phase: 'P1', gate: 'G0', type: 'feature', stage: 'building', flag: null, owner: null, deps: [], evidence: [], notes: '', parent: null };
  store.writeItems([item]);
  const text = execFileSync(process.execPath, [BIN, 'show', 'P1-01'], { cwd: root, encoding: 'utf8' });
  assert.match(text, /^gate: G0$/m, 'the raw legacy field still prints exactly as any other item property would');
  assert.equal(text.includes('gate G0 —'), false, 'the removed field is never described, since it is no longer a glossary field');
});
