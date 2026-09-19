import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS } from '../lib/settings.js';
import { SETTING_HELP } from '../lib/settings-help.js';

// The gw config editors explain every setting in plain words. A setting added
// to SETTINGS without help would show an editor that explains nothing.
test('every setting has plain-English help, and every value of a choice is described', () => {
  assert.deepEqual(Object.keys(SETTING_HELP).sort(), SETTINGS.map((setting) => setting.key).sort(), 'help and SETTINGS cover the same keys');
  for (const setting of SETTINGS) {
    const help = SETTING_HELP[setting.key];
    assert.ok(help.effect, `${setting.key} says what it changes`);
    if (setting.type === 'boolean') assert.ok(help.values?.true && help.values?.false, `${setting.key} describes both on and off`);
    for (const choice of setting.choices ?? []) assert.ok(help.values?.[choice], `${setting.key} describes ${choice}`);
    if (setting.type === 'list') assert.ok(help.values?.entry, `${setting.key} says what one entry means`);
    if (setting.type === 'integer') assert.ok(help.unit, `${setting.key} names the unit of its range`);
    if (setting.danger) assert.ok(help.danger, `${setting.key} keeps its warning, in plain words`);
  }
});

// Written for someone new to Gatewright, git and AI agents: internal words are
// either avoided or, for commands the user types, left as commands.
test('the help avoids internal jargon and internal ids', () => {
  const JARGON = /\b(triage|gate|gated|evidence|pipeline|worktree|scheduler|spawn|dispatch(ed)?|actor|terminal stage|stage role|commit-msg)\b/i;
  for (const [key, help] of Object.entries(SETTING_HELP)) {
    const texts = [help.effect, help.danger, ...Object.values(help.values ?? {})].filter(Boolean)
      // Commands and setting names are what the user types, so they may name
      // anything; only the prose around them is checked.
      .map((text) => text.replace(/`[^`]*`/g, '').replace(/\b[a-z_]+\.[a-z_.]+\b/g, ''));
    for (const text of texts) {
      assert.doesNotMatch(text, JARGON, `${key}: "${text}"`);
      if (key !== 'id_scheme') assert.doesNotMatch(text, /\b[A-Z]\d*-\d{2,}\b/, `${key} quotes no item ids`);
    }
  }
});
