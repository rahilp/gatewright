import './helpers/isolate-env.js';
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
  assert.match(
    SHELL,
    /const flagged = State\.items\.filter\(\(i\) => i\.flag && !terminal\.has\(i\.stage\)\)\.length;/,
    'the header flagged count excludes terminal items because no one can act on their holds',
  );
});

// P8-09/T-0107: the built-in run axis remains useful only while its scheduler
// is on. With it disabled, ownership is the truthful in-flight signal.
test('cards gate built-in run UI on scheduler state and render compact owners', () => {
  assert.match(SHELL, /no agent run/, 'an idle card must say that nothing is running');
  assert.match(SHELL, /<span class="tag badge-queued">queued<\/span>/, 'a queued card remains a real queued state without claiming no agent runs');
  assert.match(SHELL, /data-run-started=/, 'a running card must carry the run start so its age can be ticked');
  assert.match(SHELL, /function runLabel\(run\) \{[\s\S]*?'running · ' \+ run\.run/, 'a running card names the run');
  assert.match(SHELL, /return schedulerIsOff\(\) \? 'Queue for an agent' : 'Play';/, 'Play must read as queueing when the scheduler cannot start anything');
  assert.match(SHELL, /schedulerIsOff\(\) \? ' class="secondary"' : ''/, 'and it must not look like a button that starts work');
  assert.match(
    SHELL,
    /function showRunnerControls\(action\) \{[\s\S]*?!schedulerIsOff\(\) \|\| action\.kind === 'queued' \|\| action\.kind === 'running'/,
    'runner-off cards keep real queued/running state but hide idle runner-only UI',
  );
  assert.match(SHELL, /class="tag owner-chip" title="' \+ escapeHtml\(it\.owner\)/, 'every claimed card renders an owner chip with the full identity as its title');
  assert.match(SHELL, /function ownerLabel\(owner\) \{[\s\S]*?match\[1\] \+ ' · ' \+ match\[2\]/, 'agent/human owners have a compact readable label');
});

// --------------------------------------------------------------------------
// P8-16: `ev:0` is only useful when it names a next-stage shortfall.

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
    ${liftHelper('evidenceText')}
    ${liftHelper('stageList')}
    ${liftHelper('nextStageId')}
    ${liftHelper('evidenceGateUnmet')}
    return evidenceGateUnmet(it);
  `)(State, it);

  assert.equal(call({ stage: 'backlog', evidence: [] }), true, 'built requires 2 entries and there are none yet');
  assert.equal(call({ stage: 'backlog', evidence: ['a', 'b'] }), false, 'enough entries for the next stage\'s minimum');
  assert.equal(call({ stage: 'backlog', evidence: [{ text: 'a', stage: 'backlog' }, { text: 'b', stage: 'backlog' }] }), false, 'T-0062: object entries count by their text, not by their String()');
  assert.equal(call({ stage: 'built', evidence: ['not a pr link'] }), true, 'reviewed requires a PR link and none matches');
  assert.equal(call({ stage: 'built', evidence: ['https://github.com/x/y/pull/1'] }), false, 'a matching entry clears the gate');
  assert.equal(call({ stage: 'built', evidence: [{ text: 'https://github.com/x/y/pull/1', stage: 'built' }] }), false, 'an object entry whose TEXT matches clears the gate -- String(entry) never reaches the matcher');
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
  // Exact and derived from the table itself: every settings entry that
  // derives choices must have been checked against every config shape, so a
  // second choicesFrom setting added later is exercised here automatically
  // rather than silently dropping out of coverage.
  const derived = SETTINGS.filter((setting) => setting.choicesFrom);
  assert.ok(derived.length >= 1, 'expected at least one derived-choice setting to exercise');
  assert.equal(checked, derived.length * configs.length, 'every derived-choice setting was checked against every config shape');
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
  const empty = { scope: false, owner: false, children_done: false, evidence_min: '', evidence_match: '', deps_at_least: '' };

  assert.equal(buildRequires(empty, undefined), null, 'a gate that checks nothing is no requires at all');
  assert.equal(buildRequires({ ...empty, evidence_min: '0' }, undefined), null, 'a minimum of zero is not a rule');
  assert.deepEqual(buildRequires({ ...empty, scope: true, owner: true, children_done: true }, undefined), { scope: true, owner: true, children_done: true });
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

// T-0014: the remove button in Stages & rules deleted a stage on one
// unconfirmed click. The viewer had zero confirm() calls anywhere, so the
// misclick case -- an EMPTY stage, which the server happily deletes -- had no
// guard at all, while the case that was guarded (a stage still holding items)
// is the one the server refuses anyway.
test('removing a stage asks for confirmation and names what is lost', () => {
  const handler = SHELL.match(/\[data-stage-remove\][\s\S]*?saveStages\(doc, 'stage-row-error-' \+ id\);/);
  assert.ok(handler, 'the stage remove handler exists');
  const confirmAt = handler[0].indexOf('window.confirm');
  const docAt = handler[0].indexOf('const doc = stagesDoc()');
  assert.notEqual(confirmAt, -1, 'removal must pass through window.confirm() -- native, so it works on touch');
  assert.notEqual(docAt, -1);
  assert.ok(confirmAt < docAt, 'the confirmation must be answered before the stages document is built or saved');
  assert.match(handler[0], /stage\.label/, 'the confirmation names the stage label');
  assert.match(handler[0], /' \+ id \+ '\)/, 'the confirmation names the stage id');
  assert.match(handler[0], /its gate rules/, 'a stage carrying a gate says the gate is lost');
  assert.match(handler[0], /its terminal role/, 'a terminal stage says the role is lost');
  assert.match(handler[0], /cannot be undone/, 'the confirmation says there is no undo');
});

// T-0015: the poll re-rendered the open item panel every two seconds, wiping
// whatever a human was typing into the note box or a field. The editors had a
// dirty guard (State.formDirty); the panel -- where typing actually happens
// -- did not. "Dirty" for the panel is decided live: a control differs from
// what the render that created it put there. Unlike a sticky flag it
// unlatches itself when the typing is undone, and every render re-baselines
// it, so a saved panel is clean again and the poll takes over.
test('panel dirty means a control differs from what its render put there', () => {
  const valuesDiverge = new Function('base', 'now', `${liftHelper('valuesDiverge')}\nreturn valuesDiverge(base, now);`);

  assert.equal(valuesDiverge({ title: 'a', 'note-input': '' }, { title: 'a', 'note-input': '' }), false, 'identical snapshots are not dirty');
  assert.equal(valuesDiverge({ title: 'a' }, { title: 'b' }), true, 'typed text diverges');
  assert.equal(valuesDiverge({ title: 'a' }, { title: 'a', 'note-input': 'x' }), true, 'typing into a control that was empty at baseline diverges');
  assert.equal(valuesDiverge({ title: 'a', 'note-input': 'x' }, { title: 'a', 'note-input': 'x' }), false);
  assert.equal(valuesDiverge({ title: 'a' }, { title: '' }), true, 'clearing a value is a divergence, not a match');
  assert.equal(valuesDiverge({ 'evidence-input': '' }, {}), false, 'a control absent from both sides in practice (missing vs empty) is not a difference');
});

test('the poll cannot wipe a half-typed item panel', () => {
  assert.match(
    SHELL,
    /if \(State\.activePanelId && !panelIsDirty\(\)\) openPanel\(State\.activePanelId\);/,
    'the poll redraws the open panel only while nothing in it is half-typed',
  );
  // T-0079: refreshTransitions returns its in-flight promise, so a caller
  // arriving mid-fetch (a drop beating dragstart's request) waits on the SAME
  // verdict instead of being told the answer is still loading.
  const refreshTransitions = SHELL.match(/function refreshTransitions\([\s\S]*?\n  \}/);
  assert.ok(refreshTransitions);
  assert.match(refreshTransitions[0], /!panelIsDirty\(\)/, 'a transition verdict landing must not wipe typing either');
  assert.match(refreshTransitions[0], /return State\.transitionLoading\[id\];/, 'an in-flight fetch is awaited, never silently dropped');
  const refreshRunLog = SHELL.match(/async function refreshRunLog\([\s\S]*?\n  \}/);
  assert.ok(refreshRunLog);
  assert.match(refreshRunLog[0], /!panelIsDirty\(\)/, 'a run log landing must not wipe typing either');
  const openPanel = SHELL.match(/function openPanel\(id\) \{[\s\S]*?\n  \}/);
  assert.ok(openPanel);
  assert.match(openPanel[0], /renderPanel\(it\);/, 'opening or switching items always renders -- the dirty guard only ever defers the poll, never a deliberate switch');
  const renderPanel = SHELL.match(/function renderPanel\(it\) \{[\s\S]*?\n  \}/);
  assert.ok(renderPanel);
  assert.match(renderPanel[0], /State\.panelBaseline = capturePanelBaseline\(\);/, 'every render re-baselines, so saving or reverting unlatches the guard and no panel can go stale forever');
  const closePanel = SHELL.match(/function closePanel\(\) \{[\s\S]*?\n  \}/);
  assert.ok(closePanel);
  assert.match(closePanel[0], /State\.panelBaseline = null;/, 'closing the panel retires its baseline');
  const saveFields = SHELL.match(/async function onSaveFields\([\s\S]*?\n  \}/);
  assert.ok(saveFields);
  assert.match(saveFields[0], /State\.panelBaseline = capturePanelBaseline\(\);/, 'a successful save re-baselines -- otherwise the guard would report a divergence that no longer exists and the poll could never re-render the panel again');
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
// T-0018: the disabled forward-skip stage buttons said "use `gw move --force`
// to skip stages" -- a command a browser-only reader cannot run. The board's
// position (P8-18, and the dropAllowed test above) is that a forward skip
// stays a CLI decision; the fix is to say that plainly instead of naming a
// command, not to open the door to forward skips from the board.

test('a refused forward skip is explained as a board decision, never as a CLI command', () => {
  const dropRefusal = new Function('State', 'id', 'stageId',
    `${liftHelper('dropRefusal')}\nreturn dropRefusal(id, stageId);`);
  const State = (transitions, extra) => ({ transitions: { 'P1-01': transitions }, ...extra });

  const skip = dropRefusal(State({ built: { ok: true, force: true } }), 'P1-01', 'built');
  assert.match(skip, /board does not offer this jump/, 'a reachable-but-force-only target says the board does not offer it');
  assert.doesNotMatch(skip, /gw move --force/, 'and it does not name a command a browser user cannot run');
  assert.doesNotMatch(skip, /--force/, 'no flag a mouse has no way to pass');

  const unreachable = dropRefusal(State({}), 'P1-01', 'merged');
  assert.match(unreachable, /board does not skip stages/, 'a target with no transition verdict says the board does not skip stages');
  assert.doesNotMatch(unreachable, /gw move --force/, 'and equally does not name the CLI command');

  assert.doesNotMatch(SHELL, /use `gw move --force` to skip stages/, 'the old instruction is gone from the panel stage buttons');
  assert.doesNotMatch(SHELL, /A jump like this needs `gw move --force`/, 'and from the drag tooltips');
  assert.doesNotMatch(SHELL, /and a jump like this also needs `gw move --force`/, 'and from the unmet-gate-with-jump note');
});

test('the forward-skip stage buttons stay disabled while they say why', () => {
  // The refusal text must be attached to a button that is still off: the note
  // explains a disabled button, it must not appear on one that could fire.
  const branch = SHELL.match(/else if \(transition\.force && transition\.ok\) \{[\s\S]*?\n      \} else if/);
  assert.ok(branch, 'the forced-ok forward-skip branch is still there');
  assert.match(branch[0], /note = 'The board does not skip gates/, 'it explains itself as a board decision');
  assert.doesNotMatch(branch[0], /disabled = false/, 'a forced forward skip never becomes a live button');
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
    'the viewer and lib/brief.js disagree about which open items are "in flight" -- owned work that has progressed, or a live dispatch, belongs there on both sides',
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

// --------------------------------------------------------------------------
// T-0016: the create flow was the one write control that still rendered
// live-looking on a static snapshot and died on submit with a raw
// "Failed to fetch" (a CORS error from file://, with no console on a phone
// to discover what actually happened). Two things hold it shut:
// the "+ new item" button is hidden whenever the page is not live, and
// openCreatePanel itself refuses to render the form on a snapshot, degrading
// to the read-only banner wording every other write control already uses.
// A page also only goes live when a server actually answered /api/state --
// http alone is not permission, or a snapshot served through any static file
// server claimed to be "live" and offered that same lying form.

test('the "+ new item" control is hidden on a snapshot, and the create panel cannot render live there', () => {
  assert.match(
    SHELL,
    /<button class="clear-filters hidden" id="f-new">\+ new item<\/button>/,
    'the control ships hidden, so a snapshot shows it never',
  );
  assert.match(
    SHELL,
    /document\.getElementById\('f-new'\)\.classList\.toggle\('hidden', !State\.live\);/,
    'renderHeader keeps the hiding tied to State.live, so the two cannot drift',
  );

  // Run openCreatePanel against stub elements: once on a snapshot, once live.
  const panel = {
    innerHTML: '',
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    querySelector() { return { addEventListener() {}, focus() {} }; },
  };
  const overlay = { classList: { add() {}, remove() {}, contains() { return false; } } };
  const doc = { getElementById: (id) => (id === 'gw-panel' ? panel : overlay), querySelector: () => null };
  const run = (state) => {
    panel.innerHTML = '';
    new Function('State', 'document', 'panelEl', `
      function closePanel() {}
      function onCreateSubmit() {}
      ${liftHelper('escapeHtml')}
      ${liftHelper('panelCloseButton')}
      ${liftFunction('openCreatePanel')}
      openCreatePanel();
      return panelEl.innerHTML;
    `)(state, doc, panel);
    return { html: panel.innerHTML, state };
  };

  const snapshot = run({ live: false, activePanelId: null, creatingItem: null, config: {} });
  assert.match(snapshot.html, /class="readonly-banner"/, 'the degraded panel uses the read-only snapshot wording the item panel already uses');
  assert.match(snapshot.html, /gw add "&lt;title&gt;"/, 'and names the exact command to run instead');
  assert.match(snapshot.html, /gw open/, 'and says how to refresh the snapshot afterwards');
  assert.doesNotMatch(snapshot.html, /<form/, 'no form is rendered where nothing can be submitted');
  assert.equal(snapshot.state.creatingItem, false, 'a snapshot never enters the creating state');

  const live = run({ live: true, activePanelId: null, creatingItem: null, config: {} });
  assert.match(live.html, /<form id="create-form" class="create-form">/, 'the live branch still renders the real form');
  // The guard must sit before the form markup, so the form is unreachable on
  // a snapshot rather than merely hidden after the fact.
  const fn = liftFunction('openCreatePanel');
  assert.ok(
    fn.indexOf('if (!State.live) {') > -1 && fn.indexOf('if (!State.live) {') < fn.indexOf('<form id="create-form"'),
    'the snapshot guard is the first thing openCreatePanel does',
  );
});

test('a page only goes live when a server actually answered /api/state', () => {
  assert.match(SHELL, /fromServer: true,/, 'loadState must report when the state came from the server');
  assert.match(
    SHELL,
    /generatedAt: \(config && config\.generatedAt\) \|\| null, live: false,\n\s*fromServer: false,/,
    'an injected snapshot is reported as never having talked to a server',
  );
  assert.match(
    SHELL,
    /if \(loaded\.fromServer\) \{\n\s*State\.live = true;/,
    'boot goes live only for a real server',
  );
  assert.doesNotMatch(
    SHELL,
    /location\.protocol\.indexOf\('http'\) === 0\) \{\n\s*State\.live = true;/,
    'the old "any http page is live" shortcut is gone -- that is what made a static-served snapshot claim to be live',
  );
});

// --------------------------------------------------------------------------
// T-0017: item mentions on the Overview and Board views were plain spans
// with no role and no keyboard reach, despite opening the full edit drawer
// on click. They are now buttons in the accessibility tree: focusable,
// named after the item they open, activated by Enter and Space. Table rows
// keep their native row semantics and gain a real button on the id cell.

const CARD_HELPERS = [
  'escapeHtml', 'stageList', 'nextStageId', 'glossaryFor', 'describeTerm', 'termTitle',
  'ageLabel', 'runLabel', 'evidenceGateUnmet', 'runFor', 'isDispatched', 'isTerminalItem', 'actionFor', 'showRunnerControls', 'ownerLabel',
  'pipelineIndex', 'waitingOnDeps', 'waitsOnLabel',
].map(liftHelper).join('\n');
const CARD_ZERO_ARG = ['terminalStageIds', 'schedulerIsOff', 'playLabel', 'playTitle']
  .map(liftFunction).join('\n');

function renderCardWith(State, it) {
  return new Function('State', 'it', `
    ${CARD_ZERO_ARG}
    ${CARD_HELPERS}
    ${liftHelper('cardMarkup')}
    return cardMarkup(it, false);
  `)(State, it);
}

const CARD_STATE = () => ({
  items: [{ id: 'T-0001', title: 'Build the thing', stage: 'backlog', updated: '2024-01-01' }],
  events: [], runs: [], scheduler: { status: 'disabled' }, config: {},
  stages: { stages: [{ id: 'backlog' }, { id: 'built', role: 'done' }], extra: [] },
  transitions: {},
});

test('a board card is a focusable button named after the item it opens', () => {
  const snapshot = renderCardWith({ ...CARD_STATE(), live: false }, CARD_STATE().items[0]);
  assert.match(snapshot, /role="button" tabindex="0"/, 'the card is a button in the accessibility tree, focusable by Tab');
  assert.match(snapshot, /aria-label="Open item T-0001: Build the thing"/, 'its name says which item it opens');
  assert.doesNotMatch(snapshot, /class="card-actions"/, 'a snapshot card has no nested action buttons');

  const live = renderCardWith({ ...CARD_STATE(), live: true, scheduler: { status: 'idle' } }, CARD_STATE().items[0]);
  assert.match(live, /role="button" tabindex="0"/, 'live cards are buttons too');
  assert.match(live, /data-play="T-0001"/, 'the live card still carries its Play action');
  assert.match(live, /draggable="true"/, 'drag and drop is not regressed');
});

test('an Overview "what next" row is a focusable button named after the item it opens', () => {
  const briefSectionHtml = new Function('State', 'title', 'items', 'note', 'emptyText', `
    ${liftConstLine('BRIEF_SECTION_LIMIT')}
    ${liftHelper('escapeHtml')}
    ${liftHelper('briefSectionHtml')}
    return briefSectionHtml(title, items, note, emptyText);
  `);
  const html = briefSectionHtml({ briefExpanded: new Set() }, 'In flight', [{ id: 'T-0001', title: 'Build the thing', stage: 'building', owner: 'human:x' }], () => 'building · human:x', 'Nothing is in flight.');
  assert.match(html, /role="button" tabindex="0"/);
  assert.match(html, /aria-label="Open item T-0001: Build the thing"/);
});

test('a table row keeps its row semantics and gains a real open button on its id', () => {
  const container = { innerHTML: '' };
  new Function('State', 'container', `
    ${liftConstLine('STAGE_LABEL_FALLBACK')}
    ${CARD_ZERO_ARG}
    ${CARD_HELPERS}
    ${liftHelper('fmtDate')}
    ${liftHelper('dropAllowed')}
    ${liftHelper('pipelineIndex')}
    ${liftHelper('isBackwardTarget')}
    ${liftHelper('moveSelectOptionsHtml')}
    ${liftHelper('moveSelectHtml')}
    ${liftHelper('rowActionsHtml')}
    ${liftHelper('filteredItems')}
    ${liftHelper('stageLabel')}
    ${liftHelper('renderTable')}
    renderTable(container);
    return container.innerHTML;
  `)({ ...CARD_STATE(), live: true, filters: { phase: '', type: '', stage: '', flag: '', search: '' }, sort: { key: 'updated', dir: 'desc' } }, container);

  assert.match(container.innerHTML, /<tr data-id="T-0001">/, 'the row keeps its data-id and native row semantics');
  assert.match(
    container.innerHTML,
    /<button class="id-open" aria-label="Open item T-0001: Build the thing">T-0001<\/button>/,
    'the id cell is a real button whose name says which item it opens',
  );
  assert.match(container.innerHTML, /aria-label="Move T-0001 to another stage\."/);
});

// --------------------------------------------------------------------------
// T-0021: a title that is one very long word (newlines are sanitised away
// now, but a single unbroken 118-character word is not) has no break points,
// so it stretched its column and pushed the Board and Table views into
// horizontal overflow -- a real cost on the phone the owner reads this on.
// Titles wrap now, everywhere they render, so nothing is truncated and the
// full title needs no title attribute.

test('long unbroken titles wrap inside their column instead of stretching the page', () => {
  // CSS cannot be executed from Node, so these are presence pins on the rules;
  // the wrapping itself was verified by hand in a browser at three widths.
  assert.match(
    SHELL,
    /\.card \.card-title \{[^}]*overflow-wrap: anywhere;/,
    'a board card title breaks an unbroken word instead of painting past the 260px column',
  );
  assert.match(
    SHELL,
    /table\.gw-table td\.cell-title \{ overflow-wrap: anywhere; \}/,
    'a table title cell breaks an unbroken word instead of forcing the table wider than the viewport -- T-0027 (reopened) scoped the rule to the title column, where the T-0021 comment always said it belonged; on every td it is what let short columns break words mid-word and crush',
  );
  assert.match(
    SHELL,
    /table\.gw-table th\.cell-title, table\.gw-table td\.cell-title \{ min-width: 13rem; \}/,
    'and the same cell keeps a word-wide floor so breaking never becomes crushing',
  );
  assert.match(
    SHELL,
    /\.brief-row span:first-child \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/,
    'an overview brief row keeps its ellipsis, and min-width: 0 is what lets the flex item actually shrink to apply it',
  );
  assert.match(
    SHELL,
    /#gw-panel \{[^}]*overflow-wrap: anywhere;/,
    'the panel (fixed width) breaks long words in the title, field values and evidence chips too',
  );
});

test('keyboard activation and the missing labels and names are wired', () => {
  // Enter and Space activate the role="button" mentions, through the same
  // delegated handler the clicks already use -- and only when the FOCUSED
  // element is the control itself, so Space on a card's own Play button
  // cannot also open the drawer.
  assert.match(
    SHELL,
    /addEventListener\('keydown', \(e\) => \{\n\s*if \(e\.key !== 'Enter' && e\.key !== ' '\) return;\n\s*if \(!e\.target\.closest\) return;\n\s*const control = e\.target\.closest\('\[data-id\]\[role="button"\]'\);\n\s*if \(!control \|\| control !== e\.target\) return;\n\s*e\.preventDefault\(\);\n\s*openPanel\(control\.dataset\.id\);\n\s*\}\);/,
  );
  // Panel fields: id + name, and the dt's text is a real associated label.
  // T-0057: the label text is the human name (fieldLabel), not the raw key.
  assert.match(SHELL, /<dt><label for="panel-field-' \+ f \+ '">' \+ fieldLabel\(f\) \+ '<\/label><\/dt>/);
  assert.match(SHELL, /id="panel-field-' \+ f \+ '" name="' \+ f \+ '" data-field="' \+ f \+ '"/);
  // Evidence and note inputs, and the filter bar, are labelled.
  assert.match(SHELL, /<label class="sr-only" for="evidence-input">Add evidence<\/label>/);
  assert.match(SHELL, /<label class="sr-only" for="note-input">Add a note<\/label>/);
  for (const [id, label] of [
    ['f-phase', 'Filter by phase'], ['f-type', 'Filter by type'],
    ['f-stage', 'Filter by stage'], ['f-flag', 'Filter by flag'], ['f-search', 'Search items'],
  ]) {
    assert.match(SHELL, new RegExp('<label class="sr-only" for="' + id + '">' + label + '</label>'));
  }
  // Every close control is an × glyph; all of them must name themselves.
  assert.equal((SHELL.match(/aria-label="Close"/g) || []).length, 3, 'the item panel and both create-panel branches close via a named button');
  // Focus moves into the drawer on open, and only then -- a poll re-render
  // of an open panel must never steal focus from whoever is typing in it.
  const openPanel = SHELL.match(/function openPanel\(id\) \{[\s\S]*?\n  \}/);
  assert.ok(openPanel);
  assert.ok(
    openPanel[0].indexOf("overlay.classList.contains('open')") > -1 &&
    openPanel[0].indexOf("overlay.classList.contains('open')") < openPanel[0].indexOf('renderPanel(it);'),
    'openPanel decides whether it is opening fresh before it renders',
  );
  assert.match(openPanel[0], /if \(opening\) \{\n\s*const closeBtn = panelCloseButton\(\);\n\s*if \(closeBtn\) closeBtn\.focus\(\);\n\s*\}/);
  const closePanel = SHELL.match(/function closePanel\(\) \{[\s\S]*?\n  \}/);
  assert.match(closePanel[0], /if \(returnFocus && typeof returnFocus\.focus === 'function' && document\.contains\(returnFocus\)\) returnFocus\.focus\(\);/, 'closing hands focus back to the control that opened the drawer');
  assert.match(SHELL, /\.sr-only \{/, 'the visually-hidden label class exists');
  assert.match(SHELL, /\.card:focus-visible, \.brief-row:focus-visible \{/, 'keyboard focus is visible on the two role="button" mentions');
  // A re-render of the drawer (poll, transition verdict) must not drop the
  // keyboard focus on the floor: the focused control is found again by id or
  // data-field and focus is handed to its replacement.
  const renderPanel = SHELL.match(/function renderPanel\(it\) \{[\s\S]*?\n  \}/);
  assert.ok(renderPanel);
  assert.match(renderPanel[0], /panel\.contains\(document\.activeElement\) \? document\.activeElement : null/, 'renderPanel notices when focus is inside the drawer');
  assert.match(renderPanel[0], /input\[data-field="' \+ CSS\.escape\(active\.dataset\.field\) \+ '"\]/, 'an editable field is found again by its data-field');
  assert.match(renderPanel[0], /if \(focusSel\) \{\n\s*const again = panel\.querySelector\(focusSel\);\n\s*if \(again\) again\.focus\(\);\n\s*\}/, 'focus is restored after the re-render');
});

// --------------------------------------------------------------------------
// Round-two defects (T-0054..T-0064). Same constraint as ever: nothing in
// viewer/board.html can be imported, so pure helpers are lifted and run, and
// the panel -- the surface where T-0062 and T-0057 were reported -- is driven
// through a stub DOM so the RENDERED HTML is what the assertions see.

function liftObjectConst(name) {
  const source = SHELL.match(new RegExp(`\\n  const ${name} = \\{[\\s\\S]*?\\n  \\};`));
  assert.ok(source, `expected a const ${name} = {...} in viewer/board.html`);
  return source[0];
}

// Renders the item panel's HTML against a stub document, the way the shipped
// renderPanel() really builds it. This is the only honest way to assert on
// the panel from Node -- and T-0062 was exactly the kind of bug a grep for
// "evidence" misses: the code looked right, the RENDER said [object Object].
function renderPanelHtml(State, it) {
  const panel = {
    innerHTML: '',
    contains: () => false,
    querySelector: () => ({ addEventListener() {} }),
    querySelectorAll: () => [],
  };
  const doc = { getElementById: (id) => (id === 'gw-panel' ? panel : null), activeElement: null };
  new Function('State', 'document', 'it', `
    function closePanel() {}
    ${liftConstLine('STAGE_LABEL_FALLBACK')}
    ${liftConstLine('GLOSSARY_FIELDS')}
    ${liftObjectConst('FIELD_LABELS')}
    ${liftFunction('terminalStageIds')}
    ${['escapeHtml', 'evidenceText', 'evidenceStage', 'stageList', 'nextStageId', 'fmtDate',
      'isDispatched', 'runFor', 'isTerminalItem', 'actionFor', 'activeRunFor', 'schedulerIsOff', 'showRunnerControls',
      'playTitle', 'playLabel', 'gateFor', 'sentenceList', 'machineRule', 'pipelineIndex',
      'isBackwardTarget', 'ownerGateUnmet', 'claimActionHtml', 'stageLabel', 'glossaryFor',
      'describeTerm', 'termTitle', 'fieldLabel', 'capturePanelBaseline', 'wirePanelActions',
    ].map(liftHelper).join('\n')}
    ${liftHelper('renderPanel')}
    renderPanel(it);
    return document.getElementById('gw-panel').innerHTML;
  `)(State, doc, it);
  return panel.innerHTML;
}

const PANEL_STATE = () => ({
  live: true,
  items: [],
  events: [],
  stages: {
    stages: [
      { id: 'backlog', label: 'Backlog' },
      { id: 'building', label: 'Building', requires: { owner: true } },
      { id: 'built', label: 'Built', role: 'done' },
    ],
    extra: [{ id: 'dropped', label: 'Dropped', role: 'dropped' }],
    terminal: [],
  },
  config: {},
  runs: [],
  scheduler: { status: 'disabled' },
  transitions: {}, transitionErrors: {}, transitionLoading: {},
  runLogs: {}, runLogLoading: {}, runLogErrors: {},
  pendingEvidence: {},
  activePanelId: null,
  panelBaseline: null,
});

test('a panel refusal is retained in state and rendered again after a panel refresh', () => {
  const State = { activePanelId: 'P1-01', creatingItem: false, panelError: null };
  const errorSlot = { innerHTML: '' };
  new Function('State', 'document', 'escapeHtml', `
    ${liftHelper('showPanelError')}
    showPanelError('another reviewer must approve this item');
    return State.panelError;
  `)(State, { getElementById: (id) => (id === 'panel-error' ? errorSlot : null) }, (value) => String(value));
  assert.deepEqual(State.panelError, { panelId: 'P1-01', message: 'another reviewer must approve this item' });

  const html = renderPanelHtml({ ...PANEL_STATE(), panelError: State.panelError }, { id: 'P1-01', title: 'Held item', stage: 'backlog', evidence: [], flag: 'needs-triage' });
  assert.match(html, /another reviewer must approve this item/, 'a poll re-render preserves the refused-write explanation');
  assert.match(html, /panel-error-dismiss/, 'the reader has an explicit way to dismiss the retained error');
});

// T-0062: lib/store.js changed on-disk evidence to {text, stage} objects, and
// escapeHtml(String(entry)) turned every panel entry into "[object Object]".
// Both shapes reach the viewer -- the store normalises old boards on read, and
// import still accepts strings -- so both must render their text, and the
// panel must show WHICH GATE an entry paid for.
test('the panel renders evidence text and its gate, never [object Object], for both entry shapes', () => {
  const it = {
    id: 'T-0001',
    title: 'Carry evidence',
    stage: 'building',
    owner: null,
    evidence: [
      { text: 'abc1234', stage: 'building' },
      'legacy-plain-sha',
      { text: 'https://github.com/x/y/pull/9', stage: 'built' },
    ],
  };
  const html = renderPanelHtml(PANEL_STATE(), it);

  assert.doesNotMatch(html, /object Object/, 'no entry renders as [object Object]');
  assert.match(html, /<li class="evidence-chip">abc1234/, 'an object entry renders its text');
  assert.match(html, /<li class="evidence-chip">legacy-plain-sha/, 'a legacy string entry renders too');
  assert.match(html, /<li class="evidence-chip">https:\/\/github\.com\/x\/y\/pull\/9/);

  // The gate an entry paid for, alongside the text -- the point of the new shape.
  const gates = html.match(/<span class="tag evidence-gate"[^>]*>([^<]*)<\/span>/g) || [];
  assert.equal(gates.length, 2, 'only entries that carry a stage get a gate tag; legacy strings do not pretend to');
  assert.match(gates[0], />Building<\/span>/, 'the gate tag is the stage\'s human label');
  assert.match(html, /evidence-gate" title="Evidence supplied for the move to Built/, 'and its tooltip names the move the entry was recorded for');

  // Pending evidence (strings typed into the box) still renders and is still
  // not attributed to a gate it has not paid for yet.
  const pendingState = PANEL_STATE();
  pendingState.pendingEvidence['T-0001'] = ['typed-but-not-moved'];
  const pendingHtml = renderPanelHtml(pendingState, it);
  assert.match(pendingHtml, /typed-but-not-moved/, 'pending entries render');
  assert.doesNotMatch(pendingHtml, /object Object/);
  assert.equal((pendingHtml.match(/evidence-gate/g) || []).length, 2, 'pending entries get no gate tag');
});

test('every reader of an evidence entry goes through evidenceText', () => {
  // The panel list was the reported surface; evidenceGateUnmet's regex match
  // had the same String(entry) assumption. This pins both, plus the helpers
  // themselves.
  const evidenceText = new Function('e', `${liftHelper('evidenceText')}\nreturn evidenceText(e);`);
  const evidenceStage = new Function('e', `${liftHelper('evidenceStage')}\nreturn evidenceStage(e);`);

  assert.equal(evidenceText({ text: 'abc1234', stage: 'built' }), 'abc1234');
  assert.equal(evidenceText('legacy string'), 'legacy string');
  assert.equal(evidenceText(undefined), '', 'a missing entry renders as nothing, not "undefined"');
  assert.equal(evidenceText(null), '');
  assert.equal(evidenceText({ text: 42 }), '', 'a malformed object entry renders as nothing rather than [object Object]');

  assert.equal(evidenceStage({ text: 'x', stage: 'built' }), 'built');
  assert.equal(evidenceStage({ text: 'x', stage: null }), null, 'a legacy-normalised entry carries no gate');
  assert.equal(evidenceStage('legacy string'), null);
  assert.equal(evidenceStage(undefined), null);
  // The whole file must not render an entry object directly anywhere else.
  const direct = SHELL.match(/escapeHtml\(e(vidence)?\)/g) || [];
  assert.deepEqual(direct, [], 'evidence entries are never passed to escapeHtml raw');
});

// T-0063: a drop on a column with an unmet gate snapped back in silence.
// The reason already existed one hover away (the column tooltip, and the
// panel move strip); the refused drop must say the same sentence.
// T-0079: deciding now happens in decideDrop(), after the transitions fetch
// is awaited -- so the refusal a drop shows is always a real verdict, never
// the "Checking this gate…" placeholder a fast drag used to be punished with.
test('a refused drag names the gate in the same words the column tooltip uses', () => {
  const showDragRefusal = SHELL.match(/function showDragRefusal\(drag, stageId\) \{[\s\S]*?\n  \}/);
  assert.ok(showDragRefusal, 'the refused-drag explainer exists');
  // Same source: dropRefusal() builds the column tooltip in markDropTargets
  // and the notice here, so the wording cannot drift between them.
  assert.match(showDragRefusal[0], /dropRefusal\(drag\.id, stageId\)/, 'the notice reads the same dropRefusal() sentence the tooltip does');
  assert.match(showDragRefusal[0], /showBoardRefusal\(drag\.id, stageId, \[why\]\)/, 'and shows it in the corner notice a refused drop already owns');

  const dragover = SHELL.match(/view\.addEventListener\('dragover', \(e\) => \{[\s\S]*?\n    \}\);/);
  assert.ok(dragover);
  assert.match(dragover[0], /showDragRefusal\(drag, column\.dataset\.stage\)/, 'hovering an invalid column raises the reason');

  const decideDrop = SHELL.match(/async function decideDrop\(drag, column\) \{[\s\S]*?\n  \}/);
  assert.ok(decideDrop);
  assert.match(decideDrop[0], /showDragRefusal\(drag, to\)/, 'a drop that still arrives refused says why too');
  assert.match(decideDrop[0], /hideBoardRefusal\(\)/, 'an ACCEPTED drop clears any stale refusal notice');
});

// T-0079: a drop that beats the lazy transitions fetch used to be refused
// with "Checking this gate…" -- a placeholder standing in for a verdict that
// had not landed yet, on a move the CLI calls ready. The verdict is now
// awaited before deciding, and while it is unknown the dragover neither
// refuses nor promises: refusing the dragover would also stop the browser
// from ever firing the drop a fast flick needs.
test('a drop that beats the transitions fetch awaits the verdict instead of refusing on unknown', () => {
  const decideDrop = SHELL.match(/async function decideDrop\(drag, column\) \{[\s\S]*?\n  \}/);
  assert.ok(decideDrop, 'the drop decision is its own awaited step');
  const awaiting = decideDrop[0].indexOf('await refreshTransitions');
  const deciding = decideDrop[0].indexOf('if (!dropAllowed(');
  assert.ok(awaiting !== -1, 'the pending fetch is awaited');
  assert.ok(deciding !== -1, 'the verdict is consulted');
  assert.ok(awaiting < deciding, 'the await happens BEFORE the refusal decision, so the refusal always quotes a landed verdict');
  assert.match(decideDrop[0], /!State\.transitions\[drag\.id\] && !State\.transitionErrors\[drag\.id\]/, 'only an actually-unknown verdict is waited for; a landed one is never re-fetched');

  const dragover = SHELL.match(/view\.addEventListener\('dragover', \(e\) => \{[\s\S]*?\n    \}\);/);
  assert.ok(dragover);
  const unknown = dragover[0].indexOf('!State.transitions[drag.id]');
  const refusal = dragover[0].indexOf('showDragRefusal(drag');
  assert.ok(unknown !== -1 && refusal !== -1 && unknown < refusal, 'the unknown branch returns before any refusal while the verdict is in flight');

  // The "Checking this gate…" text may survive only as a status the panel
  // buttons already show -- it must never be what a refusal says.
  const dropRefusal = SHELL.match(/function dropRefusal\(id, stageId\) \{[\s\S]*?\n  \}/);
  assert.ok(dropRefusal);
  assert.ok(dropRefusal[0].includes('Checking this gate'), 'the placeholder remains only as the unknown-verdict status');
});

test('the drop listener hands every outcome to decideDrop and never lets the browser drop', () => {
  const drop = SHELL.match(/view\.addEventListener\('drop', \(e\) => \{[\s\S]*?\n    \}\);/);
  assert.ok(drop);
  assert.match(drop[0], /e\.preventDefault\(\)/, 'the listener owns the drop for accepted and refused outcomes alike');
  assert.match(drop[0], /decideDrop\(drag, column\)/, 'the decision is awaited, so it cannot stay inline in a sync listener');
});

// T-0054: the Overview's "+N more" was a bare <p> under rows that are all
// focusable buttons. It is a control now: one click reveals the rest of the
// section, one more folds it back, and the choice survives the poll.
test('the Overview "+N more" is a control that reveals the rest of its section', () => {
  const briefSectionHtml = new Function('State', 'title', 'items', 'note', 'emptyText', `
    ${liftConstLine('BRIEF_SECTION_LIMIT')}
    ${liftHelper('escapeHtml')}
    ${liftHelper('briefSectionHtml')}
    return briefSectionHtml(title, items, note, emptyText);
  `);
  const items = Array.from({ length: 12 }, (_, i) => ({ id: 'T-' + String(i).padStart(4, '0'), title: 'item ' + i, stage: 'building', owner: 'human:x' }));
  const collapsed = briefSectionHtml({ briefExpanded: new Set() }, 'In flight', items, () => 'note', 'Nothing is in flight.');

  assert.match(collapsed, /<button class="brief-more" data-brief-more="In flight"/, 'a real button now, not a bare <p>');
  assert.match(collapsed, /\+4 more<\/button>/);
  assert.equal((collapsed.match(/class="count-row brief-row"/g) || []).length, 8, 'collapsed still shows the limit');
  assert.match(collapsed, /aria-label="Show the remaining 4 items in In flight\."/);

  const expanded = briefSectionHtml({ briefExpanded: new Set(['In flight']) }, 'In flight', items, () => 'note', 'Nothing is in flight.');
  assert.equal((expanded.match(/class="count-row brief-row"/g) || []).length, 12, 'expanding shows every row, in place');
  assert.match(expanded, /show less<\/button>/, 'and it folds back');

  assert.match(
    SHELL,
    /const moreBtn = e\.target\.closest\('\[data-brief-more\]'\);[\s\S]*?State\.briefExpanded\.add\(section\);/,
    'the expander is wired through the one delegated click handler, onto State',
  );
  assert.match(SHELL, /briefExpanded: new Set\(\),/, 'the choice lives on State, so the 2-second poll cannot reset it');
});

// T-0055: the sticky header is ~54px and nothing reserved its height, so a
// deep card scrolled into view landed with its id and title underneath it.
test('scrolled-to targets reserve the sticky header height', () => {
  assert.match(SHELL, /html \{ scroll-padding-top: 3\.5rem; \}/, 'the scroller reserves the header height for every target');
  assert.match(SHELL, /\.card, \.brief-row, table\.gw-table tbody tr \{ scroll-margin-top: 3\.5rem; \}/, 'and the repeated scroll targets reserve it locally too');
});

// T-0056: every untyped card showed a bare "?" pill. A fresh board is mostly
// untyped items; the pill said nothing, and the tooltip it was said to have
// never existed for a null type (termTitle returns nothing for null).
test('an untyped card shows no type pill, and a typed card still does', () => {
  const state = CARD_STATE();
  const untyped = renderCardWith(state, { id: 'T-0002', title: 'Untyped', stage: 'backlog', type: null });
  assert.doesNotMatch(untyped, /class="tag"[^>]*>\?<\/span>/, 'no bare ? pill');
  const typed = renderCardWith(state, { id: 'T-0003', title: 'Typed', stage: 'backlog', type: 'defect' });
  assert.match(typed, /<span class="tag">defect<\/span>/, 'a set type still renders, tooltip and all');
});

// T-0057: the panel listed raw on-disk field names ("deps", "created_by")
// where the rest of the board spells them for a reader.
test('the item panel uses the human field names the rest of the board uses', () => {
  const it = { id: 'T-0001', title: 't', stage: 'building', owner: null, deps: ['T-0009'], created_by: 'human:rahil' };
  const html = renderPanelHtml(PANEL_STATE(), it);

  assert.match(html, /<dt><label for="panel-field-deps">Dependencies<\/label>/, 'editable fields get their human label');
  assert.doesNotMatch(html, /<dt><label for="panel-field-deps">deps<\/label>/);
  assert.match(html, /<dt>Created by<\/dt>/, 'read-only fields get their human label too');
  assert.match(html, /<dt>GitHub<\/dt>/);
  assert.doesNotMatch(html, /<dt>created_by<\/dt>/);
  assert.doesNotMatch(html, /<dt>deps<\/dt>/);
  // The fieldLabels table is the one place these names live; a field it does
  // not know falls back to its key rather than disappearing.
  const fieldLabel = new Function('f', `${liftObjectConst('FIELD_LABELS')}\n${liftHelper('fieldLabel')}\nreturn fieldLabel(f);`);
  assert.equal(fieldLabel('deps'), 'Dependencies');
  assert.equal(fieldLabel('some_future_field'), 'some_future_field');
});

// T-0058: the Table view offered Claim on a terminal item, and the claim
// route happily accepted it. Decision: the viewer HIDES the offer -- the
// offer itself is the defect, and a control whose only possible outcome is
// an error toast is a trap, not a safety. The server half (lib/serve) is
// deliberately not this file's change.
test('claim is not offered on finished work', () => {
  const rowActionsHtml = new Function('State', 'it', `
    ${liftHelper('escapeHtml')}
    ${liftHelper('isTerminalItem')}
    ${liftFunction('terminalStageIds')}
    ${liftHelper('rowActionsHtml')}
    return rowActionsHtml(it);
  `);
  const stages = { stages: [{ id: 'backlog' }, { id: 'built', role: 'done' }], extra: [{ id: 'dropped', role: 'dropped' }], terminal: [] };
  const live = { ...PANEL_STATE(), live: true, stages };

  assert.equal(
    rowActionsHtml(live, { id: 'T-0001', owner: null, stage: 'dropped' }),
    '',
    'an unowned terminal item gets no Claim button',
  );
  assert.match(
    rowActionsHtml(live, { id: 'T-0002', owner: 'human:x', can_release: true, stage: 'built' }),
    /data-release-row/,
    'an owned terminal item still gets Release',
  );
  assert.doesNotMatch(
    rowActionsHtml(live, { id: 'T-0002', owner: 'human:x', can_release: true, stage: 'built' }),
    /data-claim-row/,
  );
  assert.match(
    rowActionsHtml(live, { id: 'T-0003', owner: null, stage: 'backlog' }),
    /data-claim-row/,
    'an unfinished unowned item still gets Claim',
  );
  assert.doesNotMatch(
    rowActionsHtml(live, { id: 'T-0004', owner: 'human:x', can_release: false, stage: 'backlog' }),
    /data-release-row/,
    'a non-owner is not offered a Release button the server will refuse',
  );
});

// T-0059: one long column used to make the board a single endless strip
// (~16000px beside empty lanes on the board this was verified against).
// Decision: the board is scoped to the viewport and each column scrolls
// inside its own lane -- wrapping would break the left-to-right pipeline
// reading, and auto-scrolling to populated columns is motion the reader
// never asked for.
test('a long column scrolls inside its lane instead of growing the board past the viewport', () => {
  assert.match(SHELL, /#board \{[\s\S]*?align-items: stretch;[\s\S]*?max-height: calc\(100vh - 11rem\);/, 'the board is scoped to the visible screen');
  assert.match(SHELL, /\.column \{[\s\S]*?display: flex;\n\s*flex-direction: column;\n\s*min-height: 0;/, 'each column is a lane');
  assert.match(SHELL, /\.column-body \{[^}]*overflow-y: auto;/, 'the lane body is what scrolls');
});

// T-0027: at 390px the nowrap action columns forced the whole page sideways.
test('the table scrolls in its own lane so the page never overflows at 390px', () => {
  assert.match(SHELL, /\.table-scroll \{ overflow-x: auto;/, 'the table gets its own horizontal scroll container');
  const renderTable = SHELL.match(/function renderTable\(container\) \{[\s\S]*?\n  \}/);
  assert.ok(renderTable);
  assert.match(renderTable[0], /'<div class="table-scroll"><table class="gw-table">/, 'the table renders inside it');
  assert.match(renderTable[0], /<\/tbody><\/table><\/div>/);
  assert.match(
    SHELL,
    /@media \(max-width: 480px\) \{[\s\S]*?table\.gw-table td\.row-actions-cell \{ white-space: normal; \}/,
    'on a phone the action cells wrap instead of holding the table wide',
  );
});

// T-0064: the tab bar scrolled at 390px but nothing said so.
test('the tab bar shows that it scrolls', () => {
  assert.match(SHELL, /nav#gw-tabs \{ scrollbar-width: thin; scrollbar-color: var\(--text-faint\) transparent; \}/);
  assert.match(SHELL, /nav#gw-tabs::-webkit-scrollbar \{ height: 6px; \}/, 'the affordance is a scrollbar that is actually drawn');
  assert.match(SHELL, /@media \(max-width: 480px\) \{\n\s*nav#gw-tabs \{ padding: 0\.4rem 0\.5rem 0; \}/, 'and a phone loses the padding that pushed the last tab off the edge');
});

// T-0027 (reopened): the scroll container alone was never the fix. The table
// itself kept its width:100% and overflow-wrap:anywhere, so at 390px it
// compressed instead of scrolling -- the document scrollWidth stayed 390 and
// the Title column crushed to one character per line. Two floors hold now:
// the table cannot shrink below a readable width (the container scrolls past
// it), and the Title column cannot shrink below word width.
test('the table keeps readable floors: it scrolls as a whole and the Title column stays wide enough for words', () => {
  assert.match(SHELL, /table\.gw-table \{ min-width: 640px; \}/, 'the table has a width floor of its own -- compression is not an option');
  assert.match(SHELL, /table\.gw-table th\.cell-title, table\.gw-table td\.cell-title \{ min-width: 13rem; \}/, 'the Title column keeps word width, not letter width');
  const renderTable = SHELL.match(/function renderTable\(container\) \{[\s\S]*?\n  \}/);
  assert.ok(renderTable);
  assert.match(renderTable[0], /'<th data-key="' \+ k \+ '" class="' \+ \(k === 'title' \? 'cell-title' : ''\)/, 'the header carries the title class');
  assert.match(renderTable[0], /'<td class="cell-title">' \+ escapeHtml\(it\.title\)/, 'the body cell carries the title class');
});

// T-0078: a disabled button's reason must never be readable as the
// neighbouring button's refusal. In the bare wrap the reason could sit under
// another button's slot and the faint disabled button read as nothing, so
// the eye attached the reason to the last prominent button above it. Each
// button + its reasons are now one bounded unit.
test('a stage button and its reasons are one bounded unit, so a reason cannot attach to a neighbouring button', () => {
  const wrap = SHELL.match(/#gw-panel \.stage-button-wrap \{[\s\S]*?\n  \}/);
  assert.ok(wrap, 'the stage-button-wrap rule exists');
  assert.match(wrap[0], /border: 1px solid/, 'the pair has a visible boundary');
  assert.match(wrap[0], /padding:/, 'the boundary is not cosmetic-tight');
  assert.match(wrap[0], /flex-direction: column/, 'button then reasons, always vertical within the unit');
});

// T-0081: creating an unclassified item from the board silently held it for
// triage -- the dialog never said so. T-0113: the only cost left is the
// scheduler; the item is flagged unclassified and can be worked at once.
test('the create dialog says what an unclassified creation costs before the submit', () => {
  const openCreatePanel = SHELL.match(/function openCreatePanel\(\) \{[\s\S]*?\n  \}/);
  assert.ok(openCreatePanel);
  assert.match(openCreatePanel[0], /create-hold-note/, 'the notice is part of the form itself');
  const notice = openCreatePanel[0].match(/class="create-hold-note">([^<]+)</);
  assert.ok(notice, 'the notice renders text');
  assert.match(notice[1], /marked unclassified/, 'it names the flag');
  assert.match(notice[1], /work on it straight away/, 'it says the item is not held from its creator');
  assert.match(notice[1], /scheduler will not pick it up until it is classified or approved/, 'and names the one real cost');
  assert.doesNotMatch(notice[1], /someone other than you/, 'a human may approve their own capture');
});

// T-0082: the favicon was the only console error in an otherwise clean
// session -- a 404 on every view. A data URI works everywhere, including the
// file:// snapshot, which can never fetch a sibling favicon.
test('the board carries an inline favicon so no view 404s and the snapshot still works', () => {
  assert.match(SHELL, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/, 'an inline SVG icon, no request');
  assert.doesNotMatch(SHELL, /<link rel="icon"[^>]*href="(?!data:)/, 'no icon href that a file:// page would have to fetch');
});

// --------------------------------------------------------------------------
// T-0117..T-0120: defects the README screenshots exposed. The geometry is
// measured in a real browser in test/viewer.browser.test.js; these pin the
// logic and the rules that geometry depends on.

// T-0117: the meta span was nowrap and unshrinkable, so titles collapsed to
// "T-0003 · P…" and a long triage meta painted past the card.
test('T-0117: an Overview row wraps its meta under the title and truncates it inside the card', () => {
  assert.match(SHELL, /\.brief-row \{ cursor: pointer; gap: [^;]+; flex-wrap: wrap; \}/, 'the row may wrap');
  assert.match(SHELL, /\.brief-row span:first-child \{ flex: 1 1 12rem; \}/, 'the title claims a readable basis before the meta gets any room');
  const meta = SHELL.match(/\.brief-row span:last-child \{ flex: 0 1 auto;[^}]*\}/);
  assert.ok(meta, 'the meta span is allowed to shrink');
  assert.match(meta[0], /min-width: 0;/);
  assert.match(meta[0], /max-width: 100%;/, 'on its own line it is never wider than the card');
  assert.match(meta[0], /text-overflow: ellipsis;/);
});

test('T-0118: a dependency-blocked card names what it waits on, by the same test the Overview uses', () => {
  const run = new Function('State', 'it', `
    ${liftHelper('pipelineIndex')}
    ${liftHelper('depsReadyItem')}
    ${liftHelper('waitingOnDeps')}
    ${liftHelper('waitsOnLabel')}
    const ids = waitingOnDeps(it);
    return { ids, label: waitsOnLabel(ids), ready: depsReadyItem(it) };
  `);
  const stages = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built', requires: { deps_at_least: 'built' } }], extra: [] };
  const items = [
    { id: 'A', stage: 'backlog' },
    { id: 'B', stage: 'built' },
    { id: 'C', stage: 'building', deps: ['A', 'B'] },
    { id: 'D', stage: 'building', deps: ['A', 'X', 'Y'] },
    { id: 'E', stage: 'building', deps: ['B'] },
  ];
  const State = { stages, items };
  const byId = (id) => items.find((it) => it.id === id);

  assert.deepEqual(run(State, byId('C')), { ids: ['A'], label: 'waits on A', ready: false }, 'only the dep short of the boundary is named');
  assert.deepEqual(run(State, byId('D')), { ids: ['A', 'X', 'Y'], label: 'waits on A +2', ready: false }, 'a missing dep waits too, and extras are counted');
  assert.deepEqual(run(State, byId('E')), { ids: [], label: '', ready: true }, 'a ready item has no chip -- and agrees with depsReadyItem');

  const cardMarkup = liftHelper('cardMarkup');
  assert.match(cardMarkup, /const waits = isTerminalItem\(it\) \? \[\] : waitingOnDeps\(it\);/, 'finished work never shows a hold');
  assert.match(cardMarkup, /<span class="tag dep-wait"/, 'the card renders it as a chip');
  assert.match(SHELL, /\.tag\.dep-wait \{ color: var\(--danger\); border-color: var\(--danger\); background: var\(--danger-bg\); \}/, 'styled like the blocked flag chip');
  const update = SHELL.match(/function updateBoardInPlace\([\s\S]*?\n  \}/)[0];
  assert.match(update, /card\.dataset\.waits \|\| ''\) !== /, 'the poll redraws a card when only its dependency moved');
  assert.match(liftHelper('renderOverview'), /waitsOnLabel\(waitingOnDeps\(it\)\)/, 'the Overview Blocked row says the same thing');
});

test('T-0118: "Show all" is offered only when the preview is hiding something', () => {
  const needed = new Function('count', 'isTerminal', 'expanded', `
    ${liftConstLine('COLLAPSED_PREVIEW_COUNT')}
    ${liftHelper('columnToggleNeeded')}
    return columnToggleNeeded(count, isTerminal, expanded);
  `);
  const limit = Number(SHELL.match(/\n  const COLLAPSED_PREVIEW_COUNT = (\d+);/)[1]);
  assert.equal(needed(0, true, false), false, 'an empty Dropped has nothing to show');
  assert.equal(needed(limit, true, false), false, 'a column the preview already shows in full has nothing to show');
  assert.equal(needed(limit + 1, true, false), true, 'one hidden item is enough');
  assert.equal(needed(0, true, true), true, 'an opened column can always be folded back');
  assert.equal(needed(50, false, true), false, 'a working column never collapses');
  const update = SHELL.match(/function updateBoardInPlace\([\s\S]*?\n  \}/)[0];
  assert.match(update, /columnToggleNeeded\(inCol\.length, isTerminal, expanded\)/, 'the poll path adds and removes the toggle as counts change');
});

test('T-0118: an empty terminal or side column folds to a narrow strip that is still a column', () => {
  const folded = new Function('State', 'stageId', 'count', 'isTerminal', `
    ${liftHelper('pipelineIndex')}
    ${liftHelper('columnFolded')}
    return columnFolded(stageId, count, isTerminal);
  `);
  const State = { stages: { stages: [{ id: 'backlog' }, { id: 'in_review' }, { id: 'verified' }], extra: [{ id: 'dropped' }, { id: 'paused' }] } };
  assert.equal(folded(State, 'dropped', 0, true), true);
  assert.equal(folded(State, 'paused', 0, false), true, 'a side stage folds whether or not it is declared terminal');
  assert.equal(folded(State, 'verified', 0, true), true, 'an empty finish line folds too');
  assert.equal(folded(State, 'in_review', 0, false), false, 'an empty working stage is still where work goes next');
  assert.equal(folded(State, 'dropped', 1, true), false, 'a column with anything in it never folds');

  const renderBoard = SHELL.match(/function renderBoard\(container\) \{[\s\S]*?\n  \}/)[0];
  assert.match(renderBoard, /\(folded \? ' column-folded' : ''\) \+ '" data-stage="/, 'the folded column keeps its data-stage, so drag and drop still find it');
  assert.match(SHELL, /\.column\.column-folded \{[^}]*width: 2\.6rem;/, 'folded is narrow');
  assert.match(SHELL, /\.column \{[^}]*min-width: 11rem;[^}]*flex: 1 1 220px;/s, 'columns share the width instead of a fixed 240px each');
});

// T-0119: a forward skip is judged cumulatively, so Reviewed, Merged and
// Verified all listed In review's pull-request rule, after a lowercase
// fragment. A skip now shows only its own stage's gate, in sentences.
test('T-0119: a forward-skip stage button shows its own gate, never the gates before it', () => {
  assert.doesNotMatch(SHELL, /and a jump across stages is never offered here/, 'the fragment is gone');
  const branch = SHELL.match(/else if \(!transition \|\| \(transition\.force && !backward && pipelineIndex\(s\.id\) >= 0\)\) \{[\s\S]*?\n      \} else if/);
  assert.ok(branch, 'a pipeline skip is decided before its cumulative reasons can be shown');
  assert.match(branch[0], /const gate = gateFor\(s\.id\);/, 'it reads that one stage\'s gate');
  assert.match(branch[0], /unmet = gate\.sentences;/);
  assert.doesNotMatch(branch[0], /transition\.reasons/, 'and never the cumulative reasons');
  assert.doesNotMatch(branch[0], /disabled = false/, 'a skip stays disabled');
  for (const note of SHELL.match(/note = [^;]+;/g).filter((line) => /board|CLI/.test(line))) {
    assert.match(note, /note = (transition\s*\? )?'[A-Z]/, `a stage note starts a sentence: ${note}`);
  }
});

test('T-0120: every distribution bar in a card starts at the same x', () => {
  assert.match(liftHelper('renderOverview'), /'<div class="dist-rows">' \+ body \+ '<\/div>'/, 'a card\'s rows share one container');
  assert.match(SHELL, /\.dist-rows \{ display: grid; grid-template-columns: fit-content\(50%\) 1fr auto; \}/, 'one label column, sized to the longest label');
  assert.match(SHELL, /\.dist-rows \.count-row \{ display: grid; grid-column: 1 \/ -1; grid-template-columns: subgrid;/, 'every row lays out on that same grid');
});

test('T-0118: the rendered card wears a "waits on" chip only while a dependency holds it', () => {
  const state = CARD_STATE();
  state.stages = { stages: [{ id: 'backlog' }, { id: 'building' }, { id: 'built' }], extra: [], terminal: ['built'] };
  state.items = [
    { id: 'T-0002', title: 'Dep', stage: 'backlog', updated: '2024-01-01' },
    { id: 'T-0008', title: 'Waiter', stage: 'building', deps: ['T-0002'], updated: '2024-01-01' },
  ];
  const waiting = renderCardWith(state, state.items[1]);
  assert.match(waiting, /<span class="tag dep-wait" title="Blocked until T-0002 reaches [^"]+">waits on T-0002<\/span>/);
  assert.match(waiting, /data-waits="T-0002"/, 'the card records what it waits on, so the poll can tell when that changes');

  state.items[0].stage = 'building';
  const free = renderCardWith(state, state.items[1]);
  assert.doesNotMatch(free, /dep-wait/, 'once the dependency catches up the chip is gone');
  assert.match(free, /data-waits=""/);
});

// T-0124: the owner asked for whites and cool, tech-forward colours, never
// beige or cream. A warm neutral is one whose red channel beats its blue
// (#f5f5f3, #ececea, rgba(252, 251, 248)), so every surface the page is built
// from -- in both themes -- must keep blue >= red, and so must every other
// colour literal in the stylesheet except the status hues themselves, whose
// meaning (red for danger, amber for warning, green for ok) is the point.
const STYLE = SHELL.match(/<style>([\s\S]*?)<\/style>/)[1];
function rgbOf(literal) {
  const hex = literal.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = literal.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(fn, `unparsed colour ${literal}`);
  return fn.slice(1, 4).map(Number);
}
function varsIn(block) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const LIGHT_VARS = varsIn(STYLE.match(/:root \{\n    color-scheme: light dark;[\s\S]*?\n  \}/)[0]);
const DARK_VARS = varsIn(STYLE.match(/@media \(prefers-color-scheme: dark\) \{\n    :root \{[\s\S]*?\n    \}/)[0]);
const GLASS_LIGHT_VARS = varsIn(STYLE.match(/@media \(prefers-color-scheme: light\) \{\n    :root \{\n      --glass-edge[\s\S]*?\n    \}/)[0]);
const SURFACES = ['--bg', '--bg-raised', '--bg-sunken', '--border', '--warn-bg'];
const GLASS_SURFACES = ['--glass-edge', '--glass-base', '--glass-base-head', '--glass-fill', '--glass-fill-head', '--glass-sunken', '--glass-lane-base', '--glass-lane'];

test('T-0124: the light palette has no warm hue -- every background and surface keeps blue >= red', () => {
  for (const name of SURFACES) {
    const [r, , b] = rgbOf(LIGHT_VARS[name]);
    assert.ok(b >= r, `light ${name} ${LIGHT_VARS[name]} is warm (red ${r} > blue ${b})`);
  }
  assert.equal(LIGHT_VARS['--bg-raised'], '#ffffff', 'cards, header and panels are pure white');
  const [bgR, , bgB] = rgbOf(LIGHT_VARS['--bg']);
  assert.ok(bgB > bgR, `the page background has a cool tint, not a neutral grey (${LIGHT_VARS['--bg']})`);
  for (const name of GLASS_SURFACES) {
    const [r, , b] = rgbOf(GLASS_LIGHT_VARS[name]);
    assert.ok(b >= r, `light glass ${name} ${GLASS_LIGHT_VARS[name]} is warm`);
  }
  assert.equal(GLASS_LIGHT_VARS['--glass-sunken'], '#ffffff', 'a board card is white, not cream');
  const body = STYLE.match(/@media \(prefers-color-scheme: light\) \{\n    body \{[\s\S]*?\n    \}/)[0];
  for (const literal of body.match(/#[0-9a-f]{6}\b|rgba\([^)]*\)/gi)) {
    const [r, , b] = rgbOf(literal);
    assert.ok(b >= r, `the light page gradient carries a warm stop ${literal}`);
  }
});

test('T-0124: the dark theme shares the cool family -- no warm surface or backdrop there either', () => {
  for (const name of SURFACES) {
    const [r, , b] = rgbOf(DARK_VARS[name]);
    assert.ok(b >= r, `dark ${name} ${DARK_VARS[name]} is warm`);
  }
  // Everything outside the status hues: the glass layer, the gradients, the
  // overlay, the hover tints. The old warm-brown bloom (rgba(128, 94, 52))
  // and cream glass (rgba(252, 251, 248)) were both caught here.
  const STATUS = /^\s*--(danger|danger-bg|warn|ok|ok-bg)\s*:/;
  const offenders = [];
  for (const line of STYLE.split('\n')) {
    if (STATUS.test(line)) continue;
    for (const literal of line.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\([^)]*\)/gi) || []) {
      const [r, , b] = rgbOf(literal);
      if (r > b) offenders.push(`${literal} in: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'no warm colour literal survives anywhere in the stylesheet');
  const favicon = SHELL.match(/<link rel="icon"[^>]*>/)[0];
  assert.match(favicon, /fill='%232563eb'/, 'the favicon uses the same accent as the page');
});

test('T-0124: one accent, with readable text on it in both themes, for tabs, links, primary buttons and focus', () => {
  assert.equal(LIGHT_VARS['--accent'], '#2563eb');
  assert.doesNotMatch(STYLE, /color: #fff;/, 'no hard-coded white on the accent: the dark accent is light, so its text is dark');
  assert.equal(LIGHT_VARS['--on-accent'], '#ffffff');
  assert.equal(DARK_VARS['--on-accent'], '#0b1220');
  const lum = (hex) => {
    const c = rgbOf(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [theme, vars] of [['light', LIGHT_VARS], ['dark', DARK_VARS]]) {
    const pairs = [['--text', '--bg'], ['--text-dim', '--bg'], ['--text-faint', '--bg'], ['--text-faint', '--bg-raised'], ['--accent', '--bg'], ['--accent', '--bg-raised'],
      ['--on-accent', '--accent'], ['--accent', '--accent-bg'], ['--danger', '--danger-bg'], ['--warn', '--warn-bg'], ['--warn', '--bg'], ['--ok', '--ok-bg'],
      ['--text-dim', '--bg-sunken']];
    for (const [fg, bg] of pairs) {
      const ratio = contrast(vars[fg], vars[bg]);
      assert.ok(ratio >= 4.5, `${theme} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below WCAG AA`);
    }
  }
  assert.match(STYLE, /nav#gw-tabs button\.active \{ color: var\(--accent\); border-bottom-color: var\(--accent\);/);
  assert.match(STYLE, /a \{ color: var\(--accent\); \}/);
  assert.match(STYLE, /button:focus-visible, select:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible, summary:focus-visible \{\n    outline: 2px solid var\(--accent\);/);
  assert.match(STYLE, /\.tag\.badge-running \{ color: var\(--ok\); border-color: var\(--ok\); background: var\(--ok-bg\);/, 'the running badge was a fixed light green, unreadable on white');
  assert.equal(LIGHT_VARS['--warn-bg'], '#ffffff', 'a warning is clean amber on white, not a beige fill');
});

// T-0125: on a 278-item board at ~2000px the empty Backlog and Building lanes
// were 280px while Built (263 cards) and Dropped (14) were pinned at 160px,
// and Dropped's count clipped to "1.".
test('T-0125: columns with cards get at least the width of empty ones, and a count never truncates', () => {
  const empty = new Function('count', 'folded', `${liftHelper('columnEmpty')}; return columnEmpty(count, folded);`);
  assert.equal(empty(0, false), true, 'an empty working stage narrows');
  assert.equal(empty(0, true), false, 'a folded strip is already narrow; it does not also get the empty width');
  assert.equal(empty(3, false), false);

  assert.doesNotMatch(STYLE, /\.column\.collapsed \{[^}]*max-width/, 'a collapsed column with cards is no longer capped narrower than an empty lane');
  const emptyRule = STYLE.match(/\.column\.column-empty \{([^}]*)\}/);
  assert.ok(emptyRule, 'an empty column has a rule of its own');
  assert.match(emptyRule[1], /flex: 0\.5 1 150px;/, 'it grows at half the rate of a column with cards');
  assert.match(emptyRule[1], /max-width: 200px;/, 'and stops well short of their 280px');
  assert.match(emptyRule[1], /min-width: 9rem;/, 'but stays wide enough to be a drop target');
  assert.match(STYLE, /\.column-head \.count \{[^}]*flex-shrink: 0;/, 'the count never shrinks');
  assert.match(STYLE, /\.column-toggle \{[^}]*flex-shrink: 0;/s, '"Show all" never shrinks');
  assert.match(STYLE, /\.column-head \.column-label \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/, 'only the label may give way');
  assert.match(liftHelper('columnHeadHtml'), /<span class="column-label" title="' \+ escapeHtml\(s\.label\) \+ '">/, 'and a truncated label keeps its full name');

  const renderBoard = SHELL.match(/function renderBoard\(container\) \{[\s\S]*?\n  \}/)[0];
  assert.match(renderBoard, /\(columnEmpty\(inCol\.length, folded\) \? ' column-empty' : ''\)/);
  const update = SHELL.match(/function updateBoardInPlace\([\s\S]*?\n  \}/)[0];
  assert.match(update, /column\.classList\.toggle\('column-empty', columnEmpty\(inCol\.length, folded\)\);/, 'the poll path keeps it in step as cards come and go');
});

// T-0135: `gw open` and /api/state both cap the history they carry -- every
// event of an open item, the tail of each finished one -- and both report the
// remainder as config.eventsOmitted / config.eventsArchive. A board that
// quietly shows part of its history is indistinguishable from one that has no
// more, so the header has to say so.
const omissionState = (config) => ({ config, live: false, sync: { status: 'off' } });
const omittedHistory = (config) => new Function('State', `${liftFunction('omittedHistory')}\nreturn omittedHistory();`)(omissionState(config));
const omittedHistoryPill = (config) => new Function('State', `${liftHelper('escapeHtml')}\n${liftFunction('omittedHistory')}\n${liftFunction('omittedHistoryPill')}\nreturn omittedHistoryPill();`)(omissionState(config));

test('T-0135: the header reads the omission the CLI and the server both report, and nothing else', () => {
  assert.deepEqual(omittedHistory({ eventsOmitted: 54000, eventsArchive: 'events-archive.jsonl' }), { count: 54000, archive: 'events-archive.jsonl' });
  assert.equal(omittedHistory({}), null, 'an uncompacted board says nothing');
  assert.equal(omittedHistory({ eventsOmitted: 0 }), null, 'and neither does one that omitted nothing');
  assert.equal(omittedHistory(undefined), null, 'a board loaded before any config exists must not throw here');
  assert.equal(omittedHistory({ eventsOmitted: 'lots' }), null, 'a count that is not a number is not a count');
  assert.deepEqual(
    omittedHistory({ eventsOmitted: 7 }),
    { count: 7, archive: 'events-archive.jsonl' },
    'the archive name falls back to the one gw gc writes, so the tooltip never says "moves to .gatewright/undefined"',
  );
});

// The pill states the one thing that is true of every trimmed board -- these
// events are not on screen -- and says nothing about where they are. Both
// producers report eventsOmitted whenever the page caps what it loads, which
// happens whether or not `gw gc --events` has ever run; until it does, the
// older events are still in events.jsonl, so a pill naming the archive would
// send someone to a file that may not exist.
test('T-0135: the pill counts what is missing without claiming where it went', () => {
  const many = omittedHistoryPill({ eventsOmitted: 54000, eventsArchive: 'events-archive.jsonl' });
  assert.match(many, /^ <span class="info-pill" title="[^"]+">history trimmed · 54000 older events not shown<\/span>$/);
  assert.match(omittedHistoryPill({ eventsOmitted: 1 }), />history trimmed · 1 older event not shown</, 'one event is not "1 older events"');
  assert.equal(omittedHistoryPill({}), '', 'nothing omitted, nothing claimed');
  const label = />([^<]*)<\/span>$/.exec(many)[1];
  assert.doesNotMatch(label, /archive/, 'the visible pill must not name a file that gw gc may never have written');
});

test('T-0135: the tooltip is where the precision lives: both places the events can be, and the way to see them all', () => {
  const title = /title="([^"]*)"/.exec(omittedHistoryPill({ eventsOmitted: 54000, eventsArchive: 'events-archive.jsonl' }))[1];
  assert.match(title, /still in \.gatewright\/events\.jsonl/, 'where they are before gc runs');
  assert.match(title, /move to \.gatewright\/events-archive\.jsonl/, 'and where they go after it does');
  assert.match(title, /gw gc --events/, 'named as the thing that moves them');
  assert.match(title, /gw open --all-events/, 'the escape hatch for the whole log');
  const renamed = /title="([^"]*)"/.exec(omittedHistoryPill({ eventsOmitted: 3, eventsArchive: 'older-events.jsonl' }))[1];
  assert.match(renamed, /move to \.gatewright\/older-events\.jsonl/, 'the archive the producer actually named, not a hard-coded one');
});

test('T-0135: a hostile archive name cannot escape the tooltip', () => {
  const evil = omittedHistoryPill({ eventsOmitted: 3, eventsArchive: '"><img src=x onerror=alert(1)>' });
  assert.ok(!evil.includes('<img'), 'the archive name is escaped into the attribute, never into markup');
  assert.ok(!/title="[^"]*"[^>]*onerror/.test(evil), 'and cannot break out of the title attribute either');
});

test('T-0135: both the snapshot header and the live header carry the pill', () => {
  const header = SHELL.match(/\n  function renderHeader\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(header, /const historyPill = omittedHistoryPill\(\);/);
  assert.match(
    header,
    /document\.getElementById\('gw-snapshot-meta'\)\.innerHTML = \(State\.live[\s\S]*?\) \+ historyPill \+ syncPill;/,
    'the pill must sit outside the live/snapshot choice, or a live board would show a capped log with nothing said about it',
  );
  assert.equal(SHELL.split('omittedHistoryPill(').length - 1, 2, 'one caller, one definition: a second copy is a second wording');
});

// The poll path is where this is easy to get wrong: /api/state answers a
// `?since=` request with only the new events, so it never reports an omission
// -- and a config assignment that took it at face value would blink the pill
// out two seconds after the board opened.
test('T-0135: an incremental poll cannot blink the pill out, and a full load still replaces it', () => {
  const carry = (previous, next, incremental) => new Function('State', 'next', 'incremental',
    `${liftHelper('carryOmittedHistory')}\nreturn carryOmittedHistory(next, incremental);`)({ config: previous }, next, incremental);

  assert.deepEqual(
    carry({ version: 1, eventsOmitted: 12, eventsArchive: 'events-archive.jsonl' }, { version: 1 }, true),
    { version: 1, eventsOmitted: 12, eventsArchive: 'events-archive.jsonl' },
    'an incremental poll keeps the last full answer',
  );
  assert.deepEqual(carry({ version: 1 }, { version: 2 }, true), { version: 2 }, 'nothing to carry on an uncompacted board');
  assert.deepEqual(
    carry({ eventsOmitted: 12, eventsArchive: 'events-archive.jsonl' }, { version: 2 }, false),
    { version: 2 },
    'a full load is authoritative: a board that is no longer compacted stops claiming it is',
  );
  assert.deepEqual(
    carry({ eventsOmitted: 12 }, { eventsOmitted: 40, eventsArchive: 'events-archive.jsonl' }, true),
    { eventsOmitted: 40, eventsArchive: 'events-archive.jsonl' },
    'a response that does report an omission is believed',
  );
  assert.equal(carry({ eventsOmitted: 12 }, null, true), null, 'a missing config is left missing for the caller to fall back on');

  const poll = SHELL.match(/\n  async function poll\(\) \{[\s\S]*?\n  \}/)[0];
  assert.match(poll, /State\.config = carryOmittedHistory\(data\.config, Boolean\(since\)\) \|\| State\.config;/);
});

test('T-0135: the pill is neutral and cool in both themes, borrowing neither the warning nor the ok colour', () => {
  const rule = STYLE.match(/\.info-pill \{([^}]*)\}/);
  assert.ok(rule, 'the pill has a rule of its own');
  assert.match(rule[1], /background: var\(--bg-sunken\);/);
  assert.match(rule[1], /color: var\(--text-dim\);/);
  assert.match(rule[1], /border: 1px solid var\(--border\);/);
  assert.doesNotMatch(rule[1], /--warn|--ok|--danger/, 'omitted history is a fact about the page, not a warning or a health signal');
  // Same geometry as the pills beside it, so the header reads as one row.
  for (const property of ['font-size: 0.72rem;', 'padding: 0.15rem 0.5rem;', 'border-radius: 1rem;', 'white-space: nowrap;']) {
    assert.ok(rule[1].includes(property), `the pill must match its neighbours on ${property}`);
  }
  for (const [theme, vars] of [['light', LIGHT_VARS], ['dark', DARK_VARS]]) {
    for (const name of ['--bg-sunken', '--text-dim', '--border']) {
      const [r, , b] = rgbOf(vars[name]);
      assert.ok(b >= r, `${theme} ${name} ${vars[name]} is warm (red ${r} > blue ${b})`);
    }
  }
});
