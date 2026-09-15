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

// --------------------------------------------------------------------------
// P8-05/06/07/21: the management UI. Same constraint as above -- nothing in
// viewer/board.html can be imported -- so these tests lift the pure helpers
// out of the shipped source and run them, and pin the two tables the page
// carries against the modules they mirror.

function liftHelper(name) {
  // Same two-space indentation rule as liftFunction, but for helpers that
  // take arguments.
  const source = SHELL.match(new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(source, `expected a ${name}(...) in viewer/board.html`);
  return source[0];
}

function liftConst(name) {
  const source = SHELL.match(new RegExp(`\\n  const ${name} = \\[[\\s\\S]*?\\n  \\];`))
    || SHELL.match(new RegExp(`\\n  const ${name} = \\[.*?\\];`));
  assert.ok(source, `expected a const ${name} = [...] in viewer/board.html`);
  return source[0];
}

test('the viewer settings form is generated from the same table lib/settings.js declares', async () => {
  const { SETTINGS } = await import('../lib/settings.js');
  const viewerSettings = new Function(`${liftConst('SETTINGS')}\nreturn SETTINGS;`)();

  // choicesFrom is a function in lib/settings.js and a config path in the
  // viewer, so it is compared separately below; everything else must be equal
  // field for field, in the same order, because the form is rendered straight
  // off this table.
  const shape = (setting) => ({
    key: setting.key,
    type: setting.type,
    summary: setting.summary,
    danger: setting.danger ?? null,
    min: setting.min ?? null,
    max: setting.max ?? null,
    choices: setting.choices ?? null,
    derivesChoices: Boolean(setting.choicesFrom),
  });

  assert.deepEqual(
    viewerSettings.map(shape),
    SETTINGS.map(shape),
    'viewer/board.html carries a settings table that no longer matches lib/settings.js -- the board would offer a different set of keys, or different limits, than `gw config` accepts',
  );
});

test('a viewer choicesFrom path resolves to the same choices the CLI computes', async () => {
  const { SETTINGS } = await import('../lib/settings.js');
  const viewerSettings = new Function(`${liftConst('SETTINGS')}\nreturn SETTINGS;`)();
  const byKey = new Map(viewerSettings.map((setting) => [setting.key, setting]));
  const resolve = (path, config) => String(path).split('.').reduce((node, part) => (node == null ? undefined : node[part]), config);

  const configs = [
    {},
    { runner: {} },
    { runner: { providers: {} } },
    { runner: { providers: { claude: {}, codex: {} } } },
  ];

  let checked = 0;
  for (const setting of SETTINGS) {
    if (!setting.choicesFrom) continue;
    const mirror = byKey.get(setting.key);
    assert.ok(mirror && mirror.choicesFrom, `${setting.key} derives its choices in lib/settings.js but not in viewer/board.html`);
    for (const config of configs) {
      const node = resolve(mirror.choicesFrom, config);
      const fromViewer = node && typeof node === 'object' && !Array.isArray(node) ? Object.keys(node) : [];
      assert.deepEqual(fromViewer, setting.choicesFrom(config), `${setting.key} offers different choices on the board than in the CLI`);
      checked += 1;
    }
  }
  assert.equal(checked, configs.length, 'expected exactly one derived-choice setting to exercise');
});

test('the gate builder edits exactly the rule keys lib/rules.js reads', async () => {
  const rulesSource = readFileSync(new URL('../lib/rules.js', import.meta.url), 'utf8');
  const enforced = [...new Set([...rulesSource.matchAll(/\brequires\.([a-z_]+)/g)].map((match) => match[1]))].sort();
  const viewerKeys = new Function(`${liftConst('RULE_KEYS')}\nreturn RULE_KEYS;`)();

  assert.deepEqual(
    [...viewerKeys].sort(),
    enforced,
    'the gate builder in viewer/board.html edits a different set of keys than lib/rules.js evaluates -- an extra key is a rule the board claims and does not enforce, a missing one is a rule only reachable by hand-editing stages.json',
  );
});

test('buildRequires omits inert rules, coerces the count, and keeps keys it does not edit', () => {
  const buildRequires = new Function('values', 'existing',
    `${liftConst('RULE_KEYS')}\n${liftHelper('buildRequires')}\nreturn buildRequires(values, existing);`);
  const empty = { scope: false, owner: false, evidence_min: '', evidence_match: '', deps_at_least: '' };

  assert.equal(buildRequires(empty, undefined), null, 'a gate that checks nothing is no requires at all');
  assert.equal(buildRequires({ ...empty, evidence_min: '0' }, undefined), null, 'a minimum of zero is not a rule');
  assert.deepEqual(buildRequires({ ...empty, scope: true, owner: true }, undefined), { scope: true, owner: true });
  assert.deepEqual(buildRequires({ ...empty, evidence_min: '2' }, undefined), { evidence_min: 2 });
  assert.equal(buildRequires({ ...empty, evidence_min: '1.5' }, undefined), null, 'a count it cannot use is not written as a rule');
  assert.deepEqual(buildRequires({ ...empty, evidence_match: '  ^https://x  ' }, undefined), { evidence_match: '^https://x' });
  assert.deepEqual(buildRequires({ ...empty, deps_at_least: 'built' }, undefined), { deps_at_least: 'built' });
  assert.deepEqual(
    buildRequires(empty, { scope: true, some_future_key: 7 }),
    { some_future_key: 7 },
    'a rule key this form does not render must survive a save that never mentioned it',
  );
});

test('movePipeline reorders one stage and refuses to fall off either end', () => {
  const movePipeline = new Function('list', 'id', 'delta', `${liftHelper('movePipeline')}\nreturn movePipeline(list, id, delta);`);
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const ids = (result) => result.map((stage) => stage.id);

  assert.deepEqual(ids(movePipeline(list, 'b', -1)), ['b', 'a', 'c']);
  assert.deepEqual(ids(movePipeline(list, 'b', 1)), ['a', 'c', 'b']);
  assert.deepEqual(ids(movePipeline(list, 'a', -1)), ['a', 'b', 'c'], 'the first stage cannot move earlier');
  assert.deepEqual(ids(movePipeline(list, 'c', 1)), ['a', 'b', 'c'], 'the last stage cannot move later');
  assert.deepEqual(ids(movePipeline(list, 'nope', -1)), ['a', 'b', 'c']);
  assert.deepEqual(ids(list), ['a', 'b', 'c'], 'the caller\'s list is never mutated in place');
});

test('stagesDoc copies stages.json verbatim and drops the derived gate descriptions', () => {
  const stagesDoc = new Function('State', `${liftHelper('stagesDoc')}\nreturn stagesDoc();`);
  const State = {
    stages: {
      stages: [{ id: 'backlog', label: 'Backlog' }, { id: 'built', label: 'Built', requires: { owner: true } }],
      extra: [{ id: 'dropped', label: 'Dropped', role: 'dropped' }],
      terminal: ['built'],
      gates: { backlog: { sentences: ['x'], summary: 'x' } },
    },
  };
  const doc = stagesDoc(State);

  assert.deepEqual(doc, {
    stages: [{ id: 'backlog', label: 'Backlog' }, { id: 'built', label: 'Built', requires: { owner: true } }],
    extra: [{ id: 'dropped', label: 'Dropped', role: 'dropped' }],
    terminal: ['built'],
  }, 'the document posted back must be stages.json, not stages.json plus the English the server computed');

  doc.stages.push({ id: 'new' });
  assert.equal(State.stages.stages.length, 2, 'the copy must be deep: editing it must not edit the live payload');

  assert.deepEqual(stagesDoc({ stages: {} }), { stages: [], extra: [] }, 'an empty payload still yields a well-formed document');
});

test('one function decides whether this browser may change the rules', () => {
  const adminMode = new Function('State', `${liftFunction('adminMode')}\nreturn adminMode();`);

  assert.equal(adminMode({ live: true, admin: { allowed: true } }), 'editable');
  assert.equal(adminMode({ live: true, admin: { allowed: false } }), 'remote', 'a live board reached from elsewhere may not change stages or settings');
  assert.equal(adminMode({ live: true }), 'remote', 'a payload with no admin block is not permission');
  assert.equal(adminMode({ live: false, admin: { allowed: true } }), 'snapshot', 'a static snapshot has no server to change anything on');
  assert.equal(adminMode({ live: false }), 'snapshot');
});

test('a browser that may not change the rules is told why, in the server\'s own terms', () => {
  assert.match(
    SHELL,
    /const ADMIN_REMOTE_NOTICE = 'stages and settings can only be changed on the machine running gw serve';/,
    'the remote refusal must explain where the change has to be made',
  );
  // Structural: the editors are rendered only on the 'editable' branch, so a
  // control that would answer 403 is never drawn in the first place.
  assert.match(SHELL, /const editable = adminMode\(\) === 'editable';/, 'the stages editor is gated on adminMode()');
  assert.match(SHELL, /function renderSettings\(container\) \{\n\s*const editable = adminMode\(\) === 'editable';/, 'the settings form is gated on adminMode()');
});

// P8-21: G0, P1 and defect appeared as bare codes with nothing anywhere saying
// what they meant. The viewer cannot import lib/glossary.js, so it carries the
// same reader -- and this runs both of them over the same configs.
test('the viewer reads config.glossary exactly as lib/glossary.js does', async () => {
  const lib = await import('../lib/glossary.js');
  const viewerGlossaryFor = new Function('State', 'field', `${liftHelper('glossaryFor')}\nreturn glossaryFor(field);`);
  const viewerDescribeTerm = new Function('State', 'field', 'value',
    `${liftHelper('glossaryFor')}\n${liftHelper('describeTerm')}\nreturn describeTerm(field, value);`);

  const configs = [
    undefined,
    null,
    {},
    { glossary: null },
    { glossary: 'not a map' },
    { glossary: [] },
    { glossary: { gate: 'not a map' } },
    { glossary: { gate: [] } },
    { glossary: { gate: { G0: 'No gate: ship when it works' } } },
    { glossary: { gate: { G0: '  padded  ', G1: 42, G2: '', G3: null, G4: '   ' } } },
    { glossary: { phase: { P1: 'Foundations' }, type: { defect: 'Something is broken' } } },
  ];
  const codes = ['G0', 'G1', 'G2', 'G3', 'G4', 'P1', 'defect', 'missing', ''];

  for (const config of configs) {
    for (const field of lib.GLOSSARY_FIELDS) {
      assert.deepEqual(
        viewerGlossaryFor({ config }, field),
        lib.glossaryFor(config, field),
        `viewer and lib/glossary.js disagree about ${field} in ${JSON.stringify(config)}`,
      );
      for (const code of codes) {
        assert.equal(
          viewerDescribeTerm({ config }, field, code),
          lib.describeTerm(config, field, code),
          `viewer and lib/glossary.js disagree about ${field}.${code} in ${JSON.stringify(config)}`,
        );
      }
    }
  }
});

test('a code the glossary does not describe gets no tooltip at all', () => {
  const termTitle = new Function('State', 'field', 'value',
    `${liftHelper('escapeHtml')}\n${liftHelper('glossaryFor')}\n${liftHelper('describeTerm')}\n${liftHelper('termTitle')}\nreturn termTitle(field, value);`);
  const State = { config: { glossary: { gate: { G0: 'No gate: ship when it works' } } } };

  assert.equal(termTitle(State, 'gate', 'G0'), ' title="No gate: ship when it works"');
  assert.equal(termTitle(State, 'gate', 'G1'), '', 'an undescribed code must render exactly as it did before');
  assert.equal(termTitle(State, null, 'G0'), '', 'a field with no glossary meaning gets nothing');
  assert.equal(termTitle(State, 'gate', undefined), '');
  // The viewer looks the code up as an own property, so a board whose vocab
  // happens to contain "toString" cannot put Object.prototype.toString into a
  // title attribute. (lib/glossary.js indexes the map directly and would;
  // that difference is deliberate and only reachable with such a code.)
  assert.equal(termTitle(State, 'gate', 'toString'), '');
  assert.equal(
    termTitle({ config: { glossary: { gate: { G0: 'quotes " and <angles>' } } } }, 'gate', 'G0'),
    ' title="quotes &quot; and &lt;angles&gt;"',
    'a description is escaped before it becomes an attribute',
  );
});

test('the glossary legend puts descriptions on screen where codes are aggregated', () => {
  const glossaryLegend = new Function('State', 'field', 'codes',
    `${liftHelper('escapeHtml')}\n${liftHelper('glossaryFor')}\n${liftHelper('describeTerm')}\n${liftHelper('glossaryLegend')}\nreturn glossaryLegend(field, codes);`);
  const State = { config: { glossary: { gate: { G0: 'No gate', G1: 'Tests pass' } } } };

  assert.equal(
    glossaryLegend(State, 'gate', ['G0', 'G9', 'G1']),
    '<div class="glossary-legend"><dl><dt>G0</dt><dd>No gate</dd><dt>G1</dt><dd>Tests pass</dd></dl></div>',
    'only described codes appear, in the order the chart shows them',
  );
  assert.equal(glossaryLegend(State, 'gate', ['G9']), '', 'a chart of undescribed codes grows no legend');
  assert.equal(glossaryLegend(State, null, ['G0']), '', 'By stage is not a glossary field');
  assert.equal(glossaryLegend({ config: {} }, 'gate', ['G0']), '', 'a board with no glossary is unchanged');
});

test('every stage change is posted as the whole pipeline, and the refusal is shown verbatim', () => {
  assert.match(SHELL, /apiWrite\('\/api\/stages', doc\)/, 'stage edits PUT the whole document to /api/stages');
  assert.match(
    SHELL,
    /showAdminError\(boxId, \(result\.data && result\.data\.error\) \|\| 'request failed'\);/,
    "the server's own message must reach the screen unaltered -- it names the stage, the count and the fix",
  );
  assert.match(
    SHELL,
    /function showAdminError\(boxId, message\) \{\n\s*const box = document\.getElementById\(boxId\);\n\s*if \(box\) box\.textContent = message;/,
    'the message is set as text, so a multi-line validation refusal survives intact',
  );
  assert.match(SHELL, /\.admin-error \{[\s\S]*?white-space: pre-wrap;/, 'and its line breaks are rendered');
  assert.match(SHELL, /apiWrite\('\/api\/config', \{ settings \}\)/, 'settings are saved through /api/config');
});

test('deps_at_least is a picker of real stages, never a free-text box', () => {
  assert.match(SHELL, /function depsSelect\(id, current\) \{[\s\S]*?const pipeline = \(State\.stages\.stages \|\| \[\]\);/,
    'the dependency rule offers the pipeline stages that exist');
  const editor = SHELL.match(/function gateEditor\(stage, n\) \{[\s\S]*?\n  \}/);
  assert.ok(editor, 'expected a gateEditor in viewer/board.html');
  assert.match(editor[0], /depsSelect\(id\('deps_at_least'\), requires\.deps_at_least \|\| ''\)/);
  assert.doesNotMatch(editor[0], /data-editor="deps_at_least"[^>]*type="text"/, 'deps_at_least must not be typed by hand');
});

test('the configuration views stay reachable on a board with no items', () => {
  assert.match(
    SHELL,
    /const itemView = State\.view === 'overview' \|\| State\.view === 'board' \|\| State\.view === 'table';\n\s*if \(State\.items\.length === 0 && itemView\)/,
    'the "No items yet" screen must not hide the stages and settings views -- an empty board is exactly when they are needed',
  );
});

test('a minimum-evidence value the gate builder cannot use is refused, not silently dropped', () => {
  const gateInputProblem = new Function('values', `${liftHelper('gateInputProblem')}\nreturn gateInputProblem(values);`);

  assert.equal(gateInputProblem({ evidence_min: '' }), null, 'blank means no minimum');
  assert.equal(gateInputProblem({}), null);
  assert.equal(gateInputProblem({ evidence_min: '0' }), null);
  assert.equal(gateInputProblem({ evidence_min: '3' }), null);
  assert.equal(gateInputProblem({ evidence_min: '1.5' }), 'minimum evidence must be a whole number, or blank for no minimum.');
  assert.equal(gateInputProblem({ evidence_min: '-1' }), 'minimum evidence must be a whole number, or blank for no minimum.');
  assert.equal(gateInputProblem({ evidence_min: 'two' }), 'minimum evidence must be a whole number, or blank for no minimum.');
  // stages.json has no schema for this key, so nothing downstream would catch
  // it: the save path must ask before it builds the document.
  assert.match(
    SHELL,
    /const problem = gateInputProblem\(values\);\n\s*if \(problem\) \{ showAdminError\('stage-error-' \+ id, problem\); return; \}/,
    'the stage save path must consult gateInputProblem before posting',
  );
});

test('the poll loop cannot wipe a half-filled stages or settings form', () => {
  // The Stages and Settings views are the first views on this page that hold
  // typed input. renderView() had been called unconditionally on every
  // two-second poll, which for an editor means the form is rebuilt from the
  // payload while someone is still filling it in.
  assert.match(
    SHELL,
    /function isEditorView\(\) \{\n\s*return State\.view === 'stages' \|\| State\.view === 'settings';\n\s*\}/,
    'one predicate must name the views that hold input',
  );
  assert.match(
    SHELL,
    /else if \(isEditorView\(\)\) \{\n\s*const changed = beforeEditable !== JSON\.stringify\(\[State\.stages, State\.config, State\.admin\]\);\n\s*if \(changed && !State\.formDirty\) renderView\(\);\n\s*\}/,
    'an editor view is redrawn only when what it edits changed and nothing is half-typed',
  );
  assert.match(SHELL, /if \(isEditorView\(\)\) State\.formDirty = true;/, 'typing into an editor marks it dirty');
  // Both editors clear the flag as they render, so the guard cannot latch on.
  const stagesRender = SHELL.match(/function renderStages\(container\) \{[\s\S]*?\n  \}/);
  const settingsRender = SHELL.match(/function renderSettings\(container\) \{[\s\S]*?\n  \}/);
  assert.match(stagesRender[0], /State\.formDirty = false;/, 'rendering the stages editor clears the dirty flag');
  assert.match(settingsRender[0], /State\.formDirty = false;/, 'rendering the settings form clears the dirty flag');
  assert.match(SHELL, /State\.admin = data\.admin \|\| \{ allowed: false \};/, 'every poll re-reads whether this browser may still change the rules');
});
