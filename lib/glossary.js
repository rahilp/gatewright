// glossary — the one place that says what a code means.
//
// `config.vocab.phase` is a list of strings, and a list of strings cannot
// explain itself: a new user meets `P1`, `defect` and other codes on the board with
// nothing anywhere in the product that says what any of them are. The fix is
// additive on purpose. `config.glossary` is an OPTIONAL map of
// field → code → sentence; the vocab arrays keep their shape, so every board
// written before this existed still loads unchanged.
//
// The contract this module enforces: a glossary entry is help text, never a
// requirement. A code with no entry renders exactly as it did before, and a
// glossary block that is malformed — missing, a string, an array, a map of
// numbers — degrades to "no descriptions" rather than taking the CLI down
// with it. Nobody should lose their board because they typo'd a help string.

// The vocab fields a glossary may describe. Anything else is a typo, and
// saying so beats silently writing a map nothing will ever read.
export const GLOSSARY_FIELDS = ['phase', 'priority', 'type'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Returns the description map for one field: `{ P1: 'Do it this phase.' }`, or an
// empty object when there is nothing usable there. Never throws, never
// returns null, so callers can index the result directly.
export function glossaryFor(config, field) {
  if (!isPlainObject(config) || !isPlainObject(config.glossary)) return {};
  const entries = config.glossary[field];
  if (!isPlainObject(entries)) return {};
  const described = {};
  for (const [code, description] of Object.entries(entries)) {
    // Only strings with something in them are descriptions. A number, a null
    // or an empty string is a mistake, and rendering it would put "null" on
    // screen next to a code.
    if (code === '__proto__') continue;
    if (typeof description !== 'string' || !description.trim()) continue;
    described[code] = description.trim();
  }
  return described;
}

// The description for one code, or null when there is not one. null rather
// than '' so `describeTerm(...) ?? fallback` reads correctly at every call
// site and an absent entry can never be mistaken for a blank one.
export function describeTerm(config, field, value) {
  if (typeof value !== 'string' || !value) return null;
  return glossaryFor(config, field)[value] ?? null;
}
