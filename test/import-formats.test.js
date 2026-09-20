import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRows } from '../lib/import/csv.js';
import { parseJson } from '../lib/import/json.js';
import { parseMarkdown } from '../lib/import/md.js';

// The naive `line.split(',')` breaks on the first realistic spreadsheet
// export. Corrupting an import is worse than refusing one.
test('csv fields survive quotes, embedded commas and newlines', () => {
  const rows = parseCsvRows('a,"b,c","d""e","f\ng"\n1,2,3,4\n');
  assert.deepEqual(rows[0], ['a', 'b,c', 'd"e', 'f\ng']);
  assert.deepEqual(rows[1], ['1', '2', '3', '4']);
});

test('a csv without a trailing newline still yields its last row', () => {
  assert.deepEqual(parseCsvRows('id,title\nT-1,Last'), [['id', 'title'], ['T-1', 'Last']]);
});

test('csv headers are matched by alias and unknown columns are ignored', () => {
  const { items } = parseCsv('ID,Name,Depends On,Status,nonsense\nT-1,Title,"T-2, T-3",built,junk\n');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Title');
  assert.deepEqual(items[0].deps, ['T-2', 'T-3']);
  assert.equal(items[0].stage, 'built');
});

test('a csv whose header cannot be understood says so instead of importing nothing', () => {
  const result = parseCsv('foo,bar\n1,2\n');
  assert.match(result.error, /needs at least an "id" and a "title" column/);
  assert.match(result.error, /found: foo, bar/, 'naming what it did find is what makes this actionable');
});

test('rows missing an id or title are skipped with their line number', () => {
  const { items, skipped } = parseCsv('id,title\nT-1,Good\n,No id\nT-3,\n');
  assert.equal(items.length, 1);
  assert.deepEqual(skipped.map((entry) => entry.line), [3, 4]);
});

// Evidence is what earns a stage. Dropping it on import downgrades finished
// work and then blames the user for having no evidence.
test('evidence survives both csv and json import', () => {
  const csv = parseCsv('id,title,evidence\nT-1,Title,"abc123, test/x.test.js"\n');
  // A CSV cell is plain text: the migrated legacy shape, `stage: null`.
  assert.deepEqual(csv.items[0].evidence, [
    { text: 'abc123', stage: null },
    { text: 'test/x.test.js', stage: null },
  ]);
  // T-0061 — a `gw list --json` dump carries the on-disk `{ text, stage }`
  // objects and a hand-written file uses plain strings; both import, and the
  // stage tag survives on the objects.
  const json = parseJson('[{"id":"J-1","title":"T","evidence":["abc123",{"text":"commit def","stage":"built"}]}]');
  assert.deepEqual(json.items[0].evidence, [
    { text: 'abc123', stage: null },
    { text: 'commit def', stage: 'built' },
  ]);
});

// T-0061 — the same silence T-0053 removed from deps, on the evidence array:
// an entry that is neither a string nor a `{ text, stage? }` object must not
// vanish between the file and the board.
test('json evidence entries that are neither strings nor {text,stage} objects skip the row', () => {
  const { items, skipped } = parseJson('[{"id":"J-1","title":"x","evidence":["abc",7,{"stage":"built"}]}]');
  assert.equal(items.length, 0, 'a row whose evidence cannot be trusted must not half-import the valid entries');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 1);
  assert.match(skipped[0].reason, /invalid evidence entry: 7/);
});

test('json accepts a bare array and an items wrapper alike', () => {
  assert.equal(parseJson('[{"id":"A","title":"T"}]').items.length, 1);
  assert.equal(parseJson('{"items":[{"id":"A","title":"T"}]}').items.length, 1);
});

test('json deps may be an array or a delimited string', () => {
  assert.deepEqual(parseJson('[{"id":"A","title":"T","deps":["X","Y"]}]').items[0].deps, ['X', 'Y']);
  assert.deepEqual(parseJson('[{"id":"A","title":"T","deps":"X, Y"}]').items[0].deps, ['X', 'Y']);
});

// T-0053 — `[7, "T-0001"]` used to import as `["T-0001"]` with no trace of
// the `7`: the non-string entries were filtered out before the
// unknown-dependency check could ever see them. The row is now skipped with
// the reason and its line number, the same report a row with an unknown
// dependency gets.
test('json deps entries that are not strings skip the row with the reason and line number', () => {
  const { items, skipped } = parseJson('[{"id":"J-1","title":"x","deps":[7,"T-0001"]}]');
  assert.equal(items.length, 0, 'a row whose deps cannot be trusted must not half-import the surviving string deps');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].line, 1);
  assert.match(skipped[0].reason, /non-string dependency: 7/);
});

test('malformed json and the wrong shape are both reported, not silently empty', () => {
  assert.match(parseJson('{oops').error, /not valid JSON/);
  assert.match(parseJson('{"tasks":[]}').error, /expected a JSON array of items/);
});

test('json rows that are not objects are skipped rather than crashing', () => {
  const { items, skipped } = parseJson('["nope", null, {"id":"A","title":"T"}]');
  assert.equal(items.length, 1);
  assert.equal(skipped.length, 2);
});

// The bug that put 33 items on this project's own board holding a priority no
// vocabulary allowed.
test('no format infers priority from phase', () => {
  const md = parseMarkdown('## P4 — Phase four\n- **P4-01** · Title · feature · G0 · — · done when\n');
  assert.equal(md.items[0].phase, 'P4');
  assert.equal(md.items[0].priority, null, 'markdown has no priority column, so priority is absent, not the phase');
  assert.equal(parseCsv('id,title,phase\nT-1,T,P4\n').items[0].priority, null);
  assert.equal(parseJson('[{"id":"A","title":"T","phase":"P4"}]').items[0].priority, null);
});

// T-0134 — notes and refs were promised by PRD R8 and tasks P1-12 and read
// by no parser: csv had no alias for either, and json never looked. The
// aliases are the column names a real export uses; `description` stays
// scope, because one header cannot mean two fields.
test('csv reads notes, refs and parent through their aliases', () => {
  const { items } = parseCsv('id,title,Note,Refs,Parent ID\nT-2,Child,"why it is so","https://a.test/x, https://a.test/y",T-1\n');
  assert.equal(items[0].notes, 'why it is so');
  assert.deepEqual(items[0].refs, ['https://a.test/x', 'https://a.test/y']);
  assert.equal(items[0].parent, 'T-1');
});

test('csv columns that are absent or empty land as the empty defaults, not as empty strings', () => {
  const { items } = parseCsv('id,title,notes,refs,parent\nT-1,Solo,,,\n');
  assert.equal(items[0].notes, '');
  assert.deepEqual(items[0].refs, []);
  assert.equal(items[0].parent, null, 'an empty parent cell is no parent at all');
  assert.equal(parseCsv('id,title\nT-1,Solo\n').items[0].parent, null);
});

test('a csv description column is still scope, and does not become notes', () => {
  const { items } = parseCsv('id,title,description\nT-1,Solo,the done-when text\n');
  assert.equal(items[0].scope, 'the done-when text');
  assert.equal(items[0].notes, '');
});

test('json carries notes, refs and parent, with refs as an array or a delimited string', () => {
  const [item] = parseJson('[{"id":"J-1","title":"T","notes":"line one\\nline two","refs":["https://a.test/x"],"parent":"J-0"}]').items;
  assert.equal(item.notes, 'line one\nline two');
  assert.deepEqual(item.refs, ['https://a.test/x']);
  assert.equal(item.parent, 'J-0');
  assert.deepEqual(parseJson('[{"id":"J-1","title":"T","refs":"https://a.test/x; https://a.test/y"}]').items[0].refs, ['https://a.test/x', 'https://a.test/y']);
  const bare = parseJson('[{"id":"J-1","title":"T"}]').items[0];
  assert.equal(bare.notes, '');
  assert.deepEqual(bare.refs, []);
  assert.equal(bare.parent, null);
});

// The T-0053 rule, on the two fields that just gained a reader: a field that
// arrives as the wrong type fails its row with the reason rather than being
// quietly nulled, because a dropped field looks exactly like a clean import.
test('json refs, notes and parent of the wrong type skip the row with the reason', () => {
  const refs = parseJson('[{"id":"J-1","title":"T","refs":["ok",7]}]');
  assert.equal(refs.items.length, 0);
  assert.match(refs.skipped[0].reason, /non-string ref: 7/);

  const notes = parseJson('[{"id":"J-1","title":"T","notes":{"text":"x"}}]');
  assert.equal(notes.items.length, 0);
  assert.match(notes.skipped[0].reason, /notes must be a string/);

  const parent = parseJson('[{"id":"J-1","title":"T","parent":7}]');
  assert.equal(parent.items.length, 0);
  assert.match(parent.skipped[0].reason, /parent must be a string/);

  const shape = parseJson('[{"id":"J-1","title":"T","refs":{"a":1}}]');
  assert.equal(shape.items.length, 0);
  assert.match(shape.skipped[0].reason, /refs must be an array or a delimited string/);
});

// Markdown's six-field row has no column for any of the three, and the
// checklist form has fewer still. The importer's defaults are the format's
// limit, not a discarded field.
test('markdown expresses none of notes, refs or parent, and says so by omission', () => {
  const { items } = parseMarkdown('## P1 — phase\n- **P1-01** · A task · feature · G0 · — · Done when.\n- **P1-01.1** · A child · feature · G0 · — · Done when.\n');
  for (const item of items) {
    assert.equal(item.notes, undefined);
    assert.equal(item.refs, undefined);
    assert.equal(item.parent, undefined, 'a dotted id is the board\'s id scheme, not a parent column: inferring one would change which gates hold');
  }
});
