import { UsageError } from '../cli/errors.js';
import { readConfig } from '../config.js';
import { describeTerm, GLOSSARY_FIELDS } from '../glossary.js';
import { tamperBanner } from '../brief.js';

export const spec = { summary: 'show one item and its events', flags: { json: { type: 'boolean' } }, positionals: [{ name: 'id', required: true }] };

// `gw show` already prints `phase: P1` at a human who has no way to learn what
// P1 is. When the board has a description for a code this item actually
// carries, one line says so. Fields without a description are simply absent:
// the glossary is help, so the section shrinks to nothing on a board that has
// not written one, and `gw show` never becomes a wall of text.
function glossaryLines(config, item) {
  return GLOSSARY_FIELDS
    .map((field) => [field, item[field], describeTerm(config, field, item[field])])
    .filter(([, , description]) => description !== null)
    .map(([field, value, description]) => `  ${field} ${value} — ${description}`);
}

// T-0138 — the block printed `phase: null` on one line and `scope: ` on the
// next: two spellings of the same absence, one of them raw JSON that reads as
// a value called "null". Everything unset renders as one em dash, so a reader
// scanning the block can tell "nothing here" from "something here" without
// knowing which fields gw stores as null and which as an empty string. `0`
// and `false` are values, not absences, and keep their own spelling. `--json`
// is untouched above: scripts parse that, and a dash is not data.
const UNSET = '\u2014';

function renderValue(value) {
  if (value === null || value === undefined || value === '') return UNSET;
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : UNSET;
  if (typeof value === 'object') return Object.keys(value).length ? JSON.stringify(value) : UNSET;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function run(ctx) {
  const id = ctx.positionals[0];
  const item = ctx.store.readItems().find((candidate) => candidate.id === id);
  if (!item) throw new UsageError(`unknown item: ${id}`);
  // --json stays the raw item, byte for byte. Scripts parse this, and help
  // text is not data.
  if (ctx.flags.json) { ctx.stdout.write(`${JSON.stringify(item)}\n`); return; }
  const warning = tamperBanner(ctx.store.verifyDigest());
  if (warning) ctx.stdout.write(`${warning}\n`);
  ctx.stdout.write(`${Object.entries(item).map(([key, value]) => `${key}: ${renderValue(value)}`).join('\n')}\n`);
  const lines = glossaryLines(readConfig(ctx.store), item);
  if (lines.length) ctx.stdout.write(`\nmeaning:\n${lines.join('\n')}\n`);
  ctx.stdout.write('\nevents:\n');
  for (const event of ctx.store.readEvents().filter((event) => event.item === id)) ctx.stdout.write(`  ${JSON.stringify(event)}\n`);
}
