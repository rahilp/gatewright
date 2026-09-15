import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeRule, describeRequires } from '../lib/gates/describe.js';

// viewer/board.html has no DOM harness -- it is a single file with no build
// step and no module loader, so nothing in it can be imported. These tests do
// the two things that can honestly be done from Node: evaluate a function
// lifted verbatim out of the shipped source, and assert the structural
// invariants that the rendering depends on. Neither of them renders the page.
const SHELL = readFileSync(new URL('../viewer/board.html', import.meta.url), 'utf8');

function liftFunction(name) {
  // The viewer indents its top-level functions by two spaces inside one IIFE,
  // so the closing brace at that indentation ends the function.
  const source = SHELL.match(new RegExp(`\\n  function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(source, `expected a ${name}() in viewer/board.html`);
  return source[0];
}

// P8-10: the header counted every stage not listed in stages.terminal as
// "open", so a pipeline whose finish line is declared with `role: "done"` --
// what `gw init` writes for trunk workflows -- reported 109 open on a board
// `gw brief` called 6 open. The fix is that one helper decides this.
test('the viewer treats a role:"done" stage as terminal, not as open work', () => {
  const terminalStageIds = new Function('State', `${liftFunction('terminalStageIds')}\nreturn [...terminalStageIds()].sort();`);

  assert.deepEqual(
    terminalStageIds({ stages: { stages: [{ id: 'backlog' }, { id: 'shipped', role: 'done' }], extra: [], terminal: [] } }),
    ['shipped'],
    'a role:"done" stage is terminal even when stages.terminal is empty',
  );
  assert.deepEqual(
    terminalStageIds({ stages: { stages: [{ id: 'backlog' }, { id: 'verified' }], extra: [{ id: 'dropped' }], terminal: ['verified'] } }),
    ['dropped', 'verified'],
    'the declared terminal list and a conventional dropped stage still count',
  );
  assert.deepEqual(
    terminalStageIds({ stages: { stages: [{ id: 'backlog' }, { id: 'building' }], extra: [], terminal: [] } }),
    [],
    'a pipeline with no finish line declares none',
  );
});

test('terminal-ness is decided in exactly one place in the viewer', () => {
  const helper = liftFunction('terminalStageIds');
  const uses = SHELL.split('State.stages.terminal').length - 1;
  const insideHelper = helper.split('State.stages.terminal').length - 1;
  assert.equal(insideHelper, 1, 'terminalStageIds must be the reader of stages.terminal');
  assert.equal(
    uses, insideHelper,
    'another copy of "terminal" has appeared in viewer/board.html; route it through terminalStageIds() instead -- two notions of terminal in one file is what made the header disagree with gw brief',
  );
  // The header's open count is the surface that went wrong; keep it on the helper.
  assert.match(
    SHELL,
    /const terminal = terminalStageIds\(\);\n\s*const open = State\.items\.filter\(\(i\) => !terminal\.has\(i\.stage\)\)\.length;/,
    'the header open count must be derived from terminalStageIds()',
  );
});

// P8-09: a card in Building owned by a human with nothing running looked
// identical to one an agent was burning money on.
test('a card reports the run axis as well as the stage axis', () => {
  assert.match(SHELL, /no agent run · /, 'an idle card must say that nothing is running, and who owns it');
  assert.match(SHELL, /queued · no agent run yet/, 'a queued card must not read as a running one');
  assert.match(SHELL, /data-run-started=/, 'a running card must carry the run start so its age can be ticked');
  assert.match(SHELL, /function runLabel\(run\) \{[\s\S]*?'running · ' \+ run\.run/, 'a running card names the run');
  assert.match(SHELL, /return schedulerIsOff\(\) \? 'Queue for an agent' : 'Play';/, 'Play must read as queueing when the scheduler cannot start anything');
  assert.match(SHELL, /schedulerIsOff\(\) \? ' class="secondary"' : ''/, 'and it must not look like a button that starts work');
});

// The whole point of shipping the descriptions in the payload: if the wording
// were restated in the viewer, the two copies would drift and the board would
// describe rules the CLI does not enforce.
test('the viewer never restates the gate wording it is given', () => {
  const sentences = [
    describeRule('scope', true, {}),
    describeRule('owner', true, {}),
    describeRule('evidence_min', 1, {}),
    describeRule('evidence_match', '^https://github.com/.+/pull/\\d+', {}),
    describeRule('deps_at_least', 'built', { stages: [{ id: 'built', label: 'Built' }] }),
    ...describeRequires({}, {}),
  ];
  for (const sentence of sentences) {
    assert.ok(
      !SHELL.includes(sentence),
      `viewer/board.html contains "${sentence}" -- that wording belongs only to lib/gates/describe.js, which reaches the page through the stages payload`,
    );
  }
  assert.match(SHELL, /State\.stages && State\.stages\.gates/, 'the viewer reads the descriptions out of the payload');
});
