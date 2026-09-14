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
