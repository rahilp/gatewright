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
  assert.match(SHELL, /no agent run/, 'an idle card must say that nothing is running');
  assert.match(SHELL, /queued · no agent run yet/, 'a queued card must not read as a running one');
  assert.match(SHELL, /data-run-started=/, 'a running card must carry the run start so its age can be ticked');
  assert.match(SHELL, /function runLabel\(run\) \{[\s\S]*?'running · ' \+ run\.run/, 'a running card names the run');
  assert.match(SHELL, /return schedulerIsOff\(\) \? 'Queue for an agent' : 'Play';/, 'Play must read as queueing when the scheduler cannot start anything');
  assert.match(SHELL, /schedulerIsOff\(\) \? ' class="secondary"' : ''/, 'and it must not look like a button that starts work');
  // P8-16: the idle chip still names an owner when that is informative -- when
  // it differs from the board's obvious default -- and still says "unowned"
  // when there is none, but stops repeating the one owner every other idle
  // card already carries.
  assert.match(
    SHELL,
    /it\.owner && !ownerIsDefault \? ' · ' \+ escapeHtml\(it\.owner\) : \(it\.owner \? '' : ' · unowned'\)/,
    'the idle chip omits the owner only when it is the board\'s obvious default',
  );
});

// --------------------------------------------------------------------------
// P8-16: `ev:0` and the same owner on a hundred cards were both true and
// neither told a first-time reader anything. An evidence count is now shown
// only when it is short of what the item's own next stage requires, and an
// owner only when it is not the one most items already carry.

test('defaultOwner names the owner most items already have, and only when it really is the common case', () => {
  const defaultOwner = new Function('State', `${liftFunction('defaultOwner')}\nreturn defaultOwner();`);

  assert.equal(defaultOwner({ items: [] }), null, 'no items, no default');
  assert.equal(
    defaultOwner({ items: [{ owner: 'human:rahil' }, { owner: 'human:rahil' }, { owner: null }] }),
    'human:rahil',
    'an owner held by more than half the items is the obvious default',
  );
  assert.equal(
    defaultOwner({ items: [{ owner: 'human:rahil' }, { owner: 'human:alice' }, { owner: null }] }),
    null,
    'a board split between owners, or mostly unowned, has no obvious default to omit',
  );
  assert.equal(
    defaultOwner({ items: [{ owner: 'human:rahil' }, { owner: 'human:alice' }, { owner: 'human:alice' }] }),
    'human:alice',
    'the most common owner wins even when it is not the first one seen',
  );
});

test('evidenceGateUnmet fires only when the item\'s own next stage is short on evidence', () => {
  const stages = {
    stages: [
      { id: 'backlog' },
      { id: 'built', requires: { evidence_min: 2 } },
      { id: 'reviewed', requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
      { id: 'merged' },
    ],
    extra: [],
  };
  const State = { stages };
  const call = (it) => new Function('State', 'it', `
    ${liftHelper('stageList')}
    ${liftHelper('nextStageId')}
    ${liftHelper('evidenceGateUnmet')}
    return evidenceGateUnmet(it);
  `)(State, it);

  assert.equal(call({ stage: 'backlog', evidence: [] }), true, 'built requires 2 entries and there are none yet');
  assert.equal(call({ stage: 'backlog', evidence: ['a', 'b'] }), false, 'enough entries for the next stage\'s minimum');
  assert.equal(call({ stage: 'built', evidence: ['not a pr link'] }), true, 'reviewed requires a PR link and none matches');
  assert.equal(call({ stage: 'built', evidence: ['https://github.com/x/y/pull/1'] }), false, 'a matching entry clears the gate');
  assert.equal(call({ stage: 'reviewed', evidence: [] }), false, 'merged has no requires at all');
  assert.equal(call({ stage: 'nope', evidence: [] }), false, 'a stage outside the pipeline has no next gate either');
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
    /const itemView = State\.view === 'overview' \|\| State\.view === 'board' \|\| State\.view === 'table';\n(?:[^\n]*\n)*?\s*if \(State\.items\.length === 0 && itemView\)/,
    'the "No items yet" screen must not hide the stages and settings views -- an empty board is exactly when they are needed',
  );
});

// P8-17: the filter bar and "+ new item" rendered above Stages & rules,
// Settings, and Export, where they filter nothing on screen. itemView (just
// above) is already exactly the set of views the filter bar affects, so it
// must be the one thing that decides #gw-filters' visibility -- no second
// list of "which views" to keep in sync with the first.
test('the filter bar is shown only on the views it actually filters', () => {
  assert.match(
    SHELL,
    /document\.getElementById\('gw-filters'\)\.classList\.toggle\('hidden', !itemView\);/,
    'the filter bar\'s visibility must be driven by itemView, the same predicate that decides the empty-state screen',
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

// --------------------------------------------------------------------------
// P8-12: a terminal column (Built holding 103 of 113 cards on a real board)
// squeezed the columns that matter off to the left and pushed Dropped off the
// right edge entirely. terminalStageIds() is the one place "terminal" is
// decided in this file (P8-10 fixed that twice already); the collapse must
// read from it rather than inventing a second notion.

function liftConstLine(name) {
  const source = SHELL.match(new RegExp(`\\n  const ${name} = [^\\n]+;`));
  assert.ok(source, `expected a const ${name} = ... in viewer/board.html`);
  return source[0];
}

test('a collapsed terminal column previews the most recently touched items, an expanded one keeps the family tree', () => {
  const src = `
    ${liftHelper('hierarchicalOrder')}
    ${liftHelper('mostRecentFirst')}
    ${liftConstLine('COLLAPSED_PREVIEW_COUNT')}
    ${liftHelper('columnBodyItems')}
    return columnBodyItems(stageId, inCol, expanded);
  `;
  const columnBodyItems = new Function('stageId', 'inCol', 'expanded', src);

  const items = [
    { id: 'a', updated: '2024-01-01' },
    { id: 'b', updated: '2024-01-05' },
    { id: 'c', updated: '2024-01-03' },
    { id: 'd', updated: '2024-01-04' },
    { id: 'e', updated: '2024-01-02' },
    { id: 'f', updated: '2024-01-06' },
  ];

  const collapsed = columnBodyItems('built', items, false);
  assert.equal(collapsed.length, 5, 'a collapsed column previews a small, fixed number of items, never the whole archive');
  assert.deepEqual(
    collapsed.map((i) => i.id),
    ['f', 'b', 'd', 'c', 'e'],
    'the preview is the most recently touched items, most recent first',
  );

  const parent = { id: 'p', updated: '2024-01-01' };
  const child = { id: 'k', parent: 'p', updated: '2024-01-02' };
  const other = { id: 'q', updated: '2024-01-03' };
  const expanded = columnBodyItems('backlog', [other, child, parent], true);
  assert.deepEqual(
    expanded.map((i) => i.id),
    ['q', 'p', 'k'],
    'an expanded column keeps a child directly after its parent, exactly as an ungrouped column already did -- root order otherwise follows the input',
  );
});

test('a terminal column collapses by default and stays open across a poll once a human opens it', () => {
  assert.match(
    SHELL,
    /expandedStages: new Set\(\),/,
    'the expanded/collapsed choice must live on State, not be recomputed from the payload, so a 2-second poll cannot reset it',
  );
  // renderBoard and updateBoardInPlace (the poll-driven path) must derive
  // "expanded" the same way: terminal, unless this stage id is in the set.
  const renderBoard = SHELL.match(/function renderBoard\(container\) \{[\s\S]*?\n  \}/);
  const updateBoardInPlace = SHELL.match(/function updateBoardInPlace\([\s\S]*?\n  \}/);
  assert.ok(renderBoard && updateBoardInPlace);
  for (const [name, fn] of [['renderBoard', renderBoard], ['updateBoardInPlace', updateBoardInPlace]]) {
    assert.match(
      fn[0],
      /const expanded = !isTerminal \|\| State\.expandedStages\.has\(/,
      `${name} must default a terminal stage to collapsed and honor an explicit expansion`,
    );
  }
  // The poll path must not rebuild the whole board (which would drop the
  // in-flight animation classes and any scroll position) just to reflect a
  // toggle -- it updates the same column element's class and count in place.
  assert.match(updateBoardInPlace[0], /column\.classList\.toggle\('collapsed', isTerminal && !expanded\);/);
  assert.match(updateBoardInPlace[0], /column\.querySelector\('\.count'\)\.textContent = String\(inCol\.length\);/, 'the count is always the true total, never the preview length');
});

test('the collapse toggle is one click, and the count is always in the header', () => {
  assert.match(SHELL, /data-toggle-stage="/, 'a terminal column carries a toggle affordance');
  assert.match(
    SHELL,
    /const toggleBtn = e\.target\.closest\('\[data-toggle-stage\]'\);\n\s*if \(toggleBtn\) \{/,
    'the toggle is wired through the one delegated click handler like every other board action',
  );
  assert.match(
    SHELL,
    /if \(State\.expandedStages\.has\(stageId\)\) State\.expandedStages\.delete\(stageId\);\n\s*else State\.expandedStages\.add\(stageId\);/,
    'one click flips the state; there is no second confirmation step',
  );
  // columnHeadHtml puts the count in the same header element as the toggle,
  // for every column, whether or not it is terminal.
  const columnHeadHtml = SHELL.match(/function columnHeadHtml\([\s\S]*?\n  \}/);
  assert.ok(columnHeadHtml);
  assert.match(columnHeadHtml[0], /<span class="count">/, 'the count is rendered unconditionally, collapsed or not');
});

// --------------------------------------------------------------------------
// P8-18: a human could not drag a card back to the column it came from, and
// `gw move <id> backlog` without --force was the only path the CLI offered --
// which is not a path a mouse has. A backward move is force:true by
// definition (stageOrderMessage in lib/rules.js); the board must offer that
// one forced case without also opening the door to a forward skip.

test('isBackwardTarget reads pipeline order, not stages.extra, and ignores side stages', () => {
  const isBackwardTarget = new Function('State', 'fromStageId', 'toStageId',
    `${liftHelper('pipelineIndex')}\n${liftHelper('isBackwardTarget')}\nreturn isBackwardTarget(fromStageId, toStageId);`);
  const State = { stages: { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'in_review' }, { id: 'built' }], extra: [{ id: 'dropped' }] } };

  assert.equal(isBackwardTarget(State, 'in_review', 'building'), true, 'building comes before in_review');
  assert.equal(isBackwardTarget(State, 'building', 'in_review'), false, 'in_review comes after building -- forward');
  assert.equal(isBackwardTarget(State, 'building', 'building'), false, 'the same stage is not a backward move');
  assert.equal(isBackwardTarget(State, 'built', 'dropped'), false, 'a side stage is not "backward" -- it has its own force rule');
  assert.equal(isBackwardTarget(State, 'dropped', 'backlog'), false, 'a side stage is not in the pipeline, so it has no backward reading either');
});

test('dropAllowed offers an ordinary forward move and a backward one, but never a forward skip', () => {
  const dropAllowed = new Function('State', 'id', 'stageId',
    `${liftHelper('pipelineIndex')}\n${liftHelper('isBackwardTarget')}\n${liftHelper('dropAllowed')}\nreturn dropAllowed(id, stageId);`);
  const stages = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'in_review' }, { id: 'built' }], extra: [] };
  const items = [{ id: 'P1-01', stage: 'building' }];

  const State = (transitions) => ({ items, stages, transitions: { 'P1-01': transitions } });

  assert.equal(dropAllowed(State({ in_review: { ok: true } }), 'P1-01', 'in_review'), true, 'an ordinary next-stage move stays allowed');
  assert.equal(
    dropAllowed(State({ backlog: { ok: true, force: true } }), 'P1-01', 'backlog'),
    true,
    'a backward move is offered even though the server marks it force:true',
  );
  assert.equal(
    dropAllowed(State({ built: { ok: true, force: true } }), 'P1-01', 'built'),
    false,
    'a forward skip is still refused -- the board has no way to ask for one',
  );
  assert.equal(dropAllowed(State({ in_review: { ok: false } }), 'P1-01', 'in_review'), false, 'an unmet gate is still refused');
  assert.equal(dropAllowed(State({}), 'P1-01', 'building'), false, 'the current stage is never its own drop target');
});

test('a backward move looks different everywhere it is offered, and carries force to the server', () => {
  assert.match(SHELL, /column\.classList\.add\('drop-back'\);/, 'a backward drop target gets its own class during a drag, distinct from drop-ok');
  assert.match(SHELL, /#board\.dragging \.column\.drop-back \{ outline: 2px dashed var\(--warn\)/, 'and its own color, distinct from the accent used for a forward move');
  assert.match(SHELL, /class="move-back"/, 'a backward stage button in the panel carries its own class');
  assert.match(SHELL, /#gw-panel \.stage-buttons button\.move-back:not\(\[disabled\]\) \{[\s\S]*?color: var\(--warn\);/, 'and its own warn-colored style, distinct from the accent-colored forward buttons');
  assert.match(
    SHELL,
    /const force = Boolean\(opts && opts\.force\);\n\s*const result = await apiWrite\('\/api\/items\/' \+ encodeURIComponent\(id\) \+ '\/move', \{ to, evidence, \.\.\.\(force \? \{ force: true \} : \{\}\) \}\);/,
    'force travels to the server exactly as lib/commands/move.js\'s own --force flag does',
  );
  assert.match(
    SHELL,
    /const force = isBackwardTarget\(it\.stage, btn\.dataset\.move\);\n\s*onMoveClick\(it\.id, btn\.dataset\.move, btn, \{ force \}\);/,
    'the panel button sends force for exactly the backward case, and no other',
  );
  assert.match(
    SHELL,
    /const force = Boolean\(it && isBackwardTarget\(it\.stage, to\)\);\n\s*const result = await onMoveClick\(id, to, null, \{ force \}\);/,
    'a drag-and-drop backward move sends the same force the panel button would',
  );
});

// --------------------------------------------------------------------------
// P8-13: Overview used to be four census charts and nothing else. It is now
// "what should I do next", built on the same "in flight" lib/brief.js just
// had two bugs from a second definition of ("terminal" -- inflightTitles'
// own comment) -- so the viewer must not invent a third. This test runs the
// viewer's own isInFlightItem/computeActiveDispatch over the same fixture
// lib/brief.js's exported inFlightTitles() sees, and checks they name the
// same items. If a future change to either drifts from the other, this is
// the test that catches it.

test('the viewer\'s "in flight" is the same set gw brief computes, not a second definition of it', async () => {
  const { inFlightTitles } = await import('../lib/brief.js');

  const stages = {
    stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', role: 'done' }],
    extra: [],
  };
  const items = [
    { id: 'A', title: 'Untouched, unowned', stage: 'backlog' },
    { id: 'B', title: 'Moved past its first stage', stage: 'building', owner: 'human:x' },
    { id: 'C', title: 'Still in its first stage but actively dispatched', stage: 'backlog' },
    { id: 'D', title: 'Finished', stage: 'built', owner: 'human:x' },
    { id: 'E', title: 'Claimed but never moved and never dispatched', stage: 'backlog', owner: 'human:x' },
    { id: 'F', title: 'Dispatched once, then cancelled', stage: 'backlog' },
  ];
  const events = [
    { item: 'C', type: 'dispatch', ts: '2024-01-01T00:00:00Z', by: 'human:x' },
    { item: 'F', type: 'dispatch', ts: '2024-01-01T00:00:00Z', by: 'human:x' },
    { item: 'F', type: 'cancel', ts: '2024-01-01T00:05:00Z', by: 'human:x' },
  ];

  const fromLib = inFlightTitles({ items, events, stages }).slice().sort();

  const viewerInFlight = new Function('State', `
    ${liftFunction('terminalStageIds')}
    ${liftHelper('isTerminalItem')}
    ${liftHelper('pipelineIndex')}
    ${liftHelper('computeActiveDispatch')}
    ${liftHelper('isInFlightItem')}
    ${liftHelper('depsReadyItem')}
    ${liftFunction('briefBuckets')}
    return briefBuckets().inFlight.map((it) => it.title).sort();
  `)({ items, events, stages });

  assert.deepEqual(
    viewerInFlight, fromLib,
    'the viewer and lib/brief.js disagree about which open items are "in flight" -- claiming an item must not count on its own, and a live dispatch must, on both sides',
  );
  assert.deepEqual(fromLib, ['Moved past its first stage', 'Still in its first stage but actively dispatched'].sort());
});

// --------------------------------------------------------------------------
// P8-15: a blocked move was explained with CLI phrasing ("run `gw claim
// P8-05`") on a screen with a mouse and no terminal. lib/gates/describe.js's
// English is already carried in transition.reasons; where a reason maps to an
// action the board can perform, it must offer that action, not just nicer
// words for the same dead end.

test('claimActionHtml offers Claim exactly when the server\'s own machine failures name a missing owner, with no client-side requirement evaluator', () => {
  // P8-15's action must be read off transition.failures -- the machine text
  // evaluateCumulative in lib/rules.js already computed -- never re-derived
  // from stages.json: this repo already has a test forbidding a client-side
  // requirement evaluator in the viewer (see test/serve.test.js), so the
  // action cannot depend on the viewer re-implementing evaluateRequires.
  const claimActionHtml = new Function('State', 'it', 'machineFailures', `
    ${liftHelper('escapeHtml')}
    ${liftHelper('ownerGateUnmet')}
    ${liftHelper('claimActionHtml')}
    return claimActionHtml(it, machineFailures);
  `);

  const unowned = { id: 'P8-05', owner: null };
  const owned = { id: 'P8-05', owner: 'human:alice' };
  const ownerFailure = ['building: needs an owner: run `gw claim P8-05`'];
  const scopeFailure = ['building: needs a scope: run `gw edit P8-05 --scope "<what done looks like>"`'];

  const live = { live: true };
  const snapshot = { live: false };

  assert.match(
    claimActionHtml(live, unowned, ownerFailure),
    /<button class="reason-action" data-claim="P8-05"[^>]*>Claim<\/button>/,
    'a stage-prefixed "needs an owner" failure still gets a Claim button',
  );
  assert.equal(claimActionHtml(live, owned, ownerFailure), '', 'an item that already has an owner gets no Claim button, whatever the failures say');
  assert.equal(claimActionHtml(snapshot, unowned, ownerFailure), '', 'a read-only snapshot has no server to claim anything on');
  assert.equal(claimActionHtml(live, unowned, scopeFailure), '', 'a failure about something other than ownership gets no Claim button');
  assert.equal(claimActionHtml(live, unowned, []), '', 'no failures means nothing to act on');
});

test('the viewer still has no client-side requirement evaluator after P8-15', () => {
  assert.doesNotMatch(SHELL, /evaluateRequires/, 'the owner-gate action must not reimplement lib/rules.js\'s evaluator');
  assert.match(SHELL, /needs an owner:/, 'the detection reads the machine failure the server already computed');
});

test('the item panel wires the Claim button to a claim action, not a dead end', () => {
  assert.match(
    SHELL,
    /panel\.querySelectorAll\('\[data-claim\]'\)\.forEach\(\(btn\) => \{\n\s*btn\.addEventListener\('click', \(\) => onClaimClick\(btn\.dataset\.claim, btn\)\);/,
    'every rendered Claim button is wired to onClaimClick',
  );
  assert.match(
    SHELL,
    /async function onClaimClick\(id, btn\) \{[\s\S]*?apiWrite\('\/api\/items\/' \+ encodeURIComponent\(id\) \+ '\/claim', \{\}\)/,
    'onClaimClick posts to this item\'s claim action, mirroring the existing dispatch/cancel/resume/triage actions',
  );
});
