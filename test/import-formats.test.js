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
  assert.deepEqual(csv.items[0].evidence, ['abc123', 'test/x.test.js']);
  const json = parseJson('[{"id":"J-1","title":"T","evidence":["abc123"]}]');
  assert.deepEqual(json.items[0].evidence, ['abc123']);
});

test('json accepts a bare array and an items wrapper alike', () => {
  assert.equal(parseJson('[{"id":"A","title":"T"}]').items.length, 1);
  assert.equal(parseJson('{"items":[{"id":"A","title":"T"}]}').items.length, 1);
});

test('json deps may be an array or a delimited string', () => {
  assert.deepEqual(parseJson('[{"id":"A","title":"T","deps":["X","Y"]}]').items[0].deps, ['X', 'Y']);
  assert.deepEqual(parseJson('[{"id":"A","title":"T","deps":"X, Y"}]').items[0].deps, ['X', 'Y']);
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
