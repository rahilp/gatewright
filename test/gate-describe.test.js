import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeRule, describeRequires, describeStage } from '../lib/gates/describe.js';

const shipped = JSON.parse(readFileSync(new URL('../templates/stages.json', import.meta.url), 'utf8'));
const stages = {
  stages: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'building', label: 'Building' },
    { id: 'built', label: 'Built' },
  ],
  extra: [{ id: 'paused', label: 'Paused' }],
};

test('every documented rule key gets a sentence a human can act on', () => {
  assert.equal(describeRule('scope', true, stages), 'Scope must be filled in', 'scope names the field it demands');
  assert.equal(describeRule('owner', true, stages), 'Someone must have claimed it', 'owner explains itself as claiming, the verb the CLI uses');
  assert.equal(describeRule('evidence_min', 1, stages), 'Needs at least one new piece of evidence, distinct from anything already recorded', 'a single evidence entry reads as singular prose, not "1 evidence"');
  assert.equal(describeRule('evidence_min', 2, stages), 'Needs at least two new pieces of evidence, distinct from anything already recorded', 'small counts read as words and pluralise correctly');
  assert.equal(describeRule('evidence_min', 12, stages), 'Needs at least 12 new pieces of evidence, distinct from anything already recorded', 'counts above ten stay as digits, which parse faster than the word');
  assert.equal(
    describeRule('evidence_match', '^https://github.com/.+/pull/\\d+', stages),
    'Evidence supplied with the move must include a link to a pull request',
    'the shipped pull request pattern is explained by intent, never by pasting the regex',
  );
  assert.equal(
    describeRule('evidence_match', '^ADR-\\d+$', stages),
    'Evidence supplied with the move must match the pattern `^ADR-\\d+$`',
    'an unfamiliar pattern still gets shown rather than described wrongly',
  );
  assert.equal(describeRule('deps_at_least', 'built', stages), 'Every dependency must have reached Built', 'dependency gates name the stage by label');
  assert.equal(describeRule('children_done', true, stages), 'Every direct child item must be finished', 'parent completion says that direct child items must finish first');
});

test('a deps_at_least rule uses the named stage label, not the stage id', () => {
  const relabelled = { stages: [{ id: 'built', label: 'Shipped to staging' }] };
  assert.equal(
    describeRule('deps_at_least', 'built', relabelled),
    'Every dependency must have reached Shipped to staging',
    'the label is read from the supplied stages, so a renamed pipeline renames the sentence',
  );
  assert.equal(
    describeRule('deps_at_least', 'built', { stages: [] }),
    'Every dependency must have reached built',
    'an unknown stage id falls back to the raw id instead of producing an empty reference',
  );
});

test('an unrecognised rule is reported, never silently dropped', () => {
  const sentences = describeRequires({ owner: true, foo: 'bar' }, stages);
  assert.equal(sentences.length, 2, 'an unknown key still produces a sentence, so the board cannot under-report what it enforces');
  assert.match(sentences[1], /Unrecognised rule "foo"/, 'the unknown key is named so a human can go fix stages.json');
});

test('an inert rule value is not advertised as a gate', () => {
  assert.equal(describeRule('owner', false, stages), null, 'owner: false enforces nothing and must not read as a requirement');
  assert.equal(describeRule('evidence_min', 0, stages), null, 'a zero minimum enforces nothing and must not read as a requirement');
  assert.equal(describeRule('children_done', false, stages), null, 'an explicit false child gate is inert');
  assert.deepEqual(
    describeRequires({ owner: false }, stages),
    ['Nothing is checked here: this stage is advanced by hand'],
    'a requires block whose every rule is inert is honestly described as unchecked',
  );
});

test('an absent or empty requires says the stage is advanced by hand', () => {
  const expected = ['Nothing is checked here: this stage is advanced by hand'];
  assert.deepEqual(describeRequires(undefined, stages), expected, 'an absent requires is described, not left blank');
  assert.deepEqual(describeRequires({}, stages), expected, 'an empty requires is described, not left blank');
  assert.deepEqual(describeStage({ id: 'backlog', label: 'Backlog' }, stages).sentences, expected, 'a stage with no gate still explains itself');
});

test('describeStage summarises its sentences on one line', () => {
  const stage = { id: 'built', label: 'Built', requires: { evidence_min: 1, deps_at_least: 'built' } };
  const { sentences, summary } = describeStage(stage, stages);
  assert.deepEqual(sentences, ['Needs at least one new piece of evidence, distinct from anything already recorded', 'Every dependency must have reached Built'], 'every rule in the block is described, in declaration order');
  assert.equal(summary, sentences.join('; '), 'the summary is exactly the sentences, so a column header cannot disagree with its detail');
  assert.equal(summary.includes('\n'), false, 'the summary stays on one line for a column header');
});

test('every shipped stage describes itself in prose, with no JSON leaking through', () => {
  const all = [...(shipped.stages ?? []), ...(shipped.extra ?? [])];
  assert.ok(all.length > 0, 'the shipped stages.json is the fixture under test and must not be empty');
  for (const stage of all) {
    const { sentences, summary } = describeStage(stage, shipped);
    assert.ok(sentences.length >= 1, `stage ${stage.id} must produce at least one sentence, because a gate with no explanation is a gate no one can trust`);
    assert.ok(summary.length > 0, `stage ${stage.id} must produce a non-empty summary`);
    for (const sentence of sentences) {
      assert.equal(sentence.includes('{'), false, `stage ${stage.id} leaked a raw JSON brace into "${sentence}"`);
      assert.equal(sentence.includes('"'), false, `stage ${stage.id} leaked a raw JSON quote into "${sentence}"`);
      assert.equal(sentence.includes('\\d'), false, `stage ${stage.id} leaked a raw regex into "${sentence}" instead of explaining it`);
      assert.equal(sentence, sentence.trim(), `stage ${stage.id} produced a sentence with stray whitespace`);
      assert.match(sentence, /^[A-Z]/, `stage ${stage.id} must produce a sentence that starts like one`);
    }
  }
});

test('shipped stages render the exact wording the board will show', () => {
  const byId = Object.fromEntries([...shipped.stages, ...shipped.extra].map((stage) => [stage.id, stage]));
  assert.deepEqual(describeStage(byId.building, shipped).sentences, ['Someone must have claimed it'], 'the Building gate explains the claim it requires');
  assert.deepEqual(
    describeStage(byId.built, shipped).sentences,
    ['Scope must be filled in', 'Needs at least one new piece of evidence, distinct from anything already recorded', 'Every dependency must have reached Built'],
    'the Built gate explains the scope it is named after, its evidence minimum, and its dependency boundary',
  );
  assert.deepEqual(describeStage(byId.in_review, shipped).sentences, ['Evidence supplied with the move must include a link to a pull request'], 'the In review gate explains its regex as a pull request link');
  assert.deepEqual(describeStage(byId.merged, shipped).sentences, ['Every dependency must have reached Merged'], 'the Merged gate names the dependency boundary by label');
  assert.deepEqual(describeStage(byId.verified, shipped).sentences, ['Needs at least two new pieces of evidence, distinct from anything already recorded', 'Every direct child item must be finished'], 'the Verified gate requires both fresh validation evidence and finished child work');
});
