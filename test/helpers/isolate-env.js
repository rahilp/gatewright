// T-0123 — the caller's gw state must never reach the suite. Tests spawn gw
// with a scratch cwd and the inherited environment, and gw prefers GW_ROOT
// over the cwd: a shell with GW_ROOT exported sent every fixture item into
// the board it named, which on the owner's machine was their real one. The
// actor and agent variables are the same class of leak: they change who gw
// says did something, so a test that expects `human:*` fails, or passes by
// luck, depending on which terminal ran it.
//
// Every test file imports this module FIRST. ES modules evaluate their
// imports in order, so the delete below runs before any other test code,
// and before any child process can be spawned with the caller's environment.
// That covers a bare `node --test test/x.test.js`, which never goes through
// scripts/test.mjs; the runner scrubs its child environment as well, so the
// two paths agree. test/env-isolation.test.js fails any test file that
// forgets the import, and any GW_* variable gw starts reading that is not
// listed here.
//
// A test that needs one of these sets it explicitly, in the env it passes to
// the process it spawns.
export const ISOLATED_VARS = [
  // Which board gw writes to.
  'GW_ROOT',
  // Who gw records as having done it, and the item a runner-launched agent owns.
  'GW_ACTOR',
  'GW_ITEM',
  // How gw talks to the terminal and what it prints on error.
  'GW_NO_INPUT',
  'GW_TUI',
  'GW_DEBUG',
  // Agent sessions. CURSOR_AGENT changes triage's default actor today; the
  // others mark an agent's shell and are removed so no test depends on
  // whether it was launched by one.
  'CLAUDECODE',
  'AI_AGENT',
  'CURSOR_AGENT',
];

// Windows environment names are case-insensitive. process.env handles that
// itself, but a plain copy of it does not, so match on the upper-cased name.
export function withoutCallerState(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !ISOLATED_VARS.includes(key.toUpperCase())));
}

for (const key of Object.keys(process.env)) {
  if (ISOLATED_VARS.includes(key.toUpperCase())) delete process.env[key];
}
