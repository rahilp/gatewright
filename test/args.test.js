import './helpers/isolate-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../lib/cli/args.js';
import { UsageError } from '../lib/cli/errors.js';

const spec = { flags: { evidence: { type: 'string', repeat: true }, json: { type: 'boolean' }, by: { type: 'string' } }, positionals: [{ name: 'id', required: true }] };

test('parseArgs supports values, equals syntax, booleans, and repeated flags', () => {
  assert.deepEqual(parseArgs(['P1-01', '--evidence', 'abc', '--evidence=url', '--json', '--by=human:a'], spec), {
    positionals: ['P1-01'], flags: { evidence: ['abc', 'url'], json: true, by: 'human:a' },
  });
});

test('parseArgs ends option processing at --', () => {
  assert.deepEqual(parseArgs(['P1-01', '--', '--not-a-flag'], spec), { positionals: ['P1-01', '--not-a-flag'], flags: {} });
});

test('parseArgs rejects unknown flags, absent values, and absent required positionals', () => {
  for (const argv of [['--wat', 'P1-01'], ['P1-01', '--by'], ['P1-01', '--by', '--json'], []]) {
    assert.throws(() => parseArgs(argv, spec), UsageError);
  }
});

// T-0040 — a flag that declares allowEmpty treats an explicit empty string
// as a value (`gw edit <id> --deps ""` means "clear the list"), while a
// genuinely missing value — end of argv, or the next token is another flag —
// is still a usage error. Default flags are unchanged: '' is refused.
test('parseArgs lets an allowEmpty flag receive an explicit empty string, and nothing else', () => {
  const clearable = { flags: { deps: { type: 'string', allowEmpty: true } }, positionals: [{ name: 'id', required: true }] };
  assert.deepEqual(parseArgs(['P1-01', '--deps', ''], clearable), { positionals: ['P1-01'], flags: { deps: '' } });
  assert.deepEqual(parseArgs(['P1-01', '--deps='], clearable), { positionals: ['P1-01'], flags: { deps: '' } });
  assert.deepEqual(parseArgs(['P1-01', '--deps', 'a,b'], clearable), { positionals: ['P1-01'], flags: { deps: 'a,b' } });
  for (const argv of [['P1-01', '--deps'], ['P1-01', '--deps', '--title', 'x']]) {
    assert.throws(() => parseArgs(argv, clearable), UsageError);
  }
  assert.throws(() => parseArgs(['P1-01', '--by', ''], spec), UsageError, 'the default is unchanged: an empty value is a missing value');
});
