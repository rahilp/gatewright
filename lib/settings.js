// The settings a user is expected to change, declared once.
//
// This list is the single source of truth for `gw config` and for the `gw
// init` wizard, so the two cannot drift into disagreeing about what a valid
// setting is. It deliberately does not cover everything in config.json: the
// structures are named in FILE_ONLY below with the reason each one is
// file-only, so "unknown setting" is never the answer for a key that exists.
import { GLOSSARY_FIELDS } from './glossary.js';

export const SETTINGS = [
  {
    key: 'runner.enabled',
    type: 'boolean',
    summary: 'Let the scheduler start agent runs. Off means Play only queues.',
    danger: 'This is the switch that lets gw spawn processes on this machine.',
  },
  { key: 'runner.provider', type: 'string', summary: 'Which entry in runner.providers to invoke.', choicesFrom: (config) => Object.keys(config.runner?.providers ?? {}) },
  { key: 'runner.max_concurrent', type: 'integer', min: 1, max: 64, summary: 'How many runs may be live at once.' },
  { key: 'runner.tick_s', type: 'integer', min: 1, max: 3600, summary: 'Seconds between scheduler ticks.' },
  { key: 'runner.run_timeout_min', type: 'integer', min: 1, max: 1440, summary: 'Minutes before a run is stopped as overrunning.' },
  { key: 'runner.stop_timeout_s', type: 'integer', min: 0, max: 600, summary: 'Grace period between a stop request and force.' },
  { key: 'runner.paused', type: 'boolean', summary: 'Global pause. Keeps config intact while stopping new runs.' },
  { key: 'runner.prompt_template', type: 'string', summary: 'Prompt file used to start each run, resolved from the board root.' },
  { key: 'runner.worktree_root', type: 'string', summary: 'Where per-item worktrees are created, resolved from the board root.' },
  { key: 'policy.auto_dispatch_children', type: 'boolean', summary: 'Whether agent-created children dispatch without a human.', danger: 'Leaving this off is what stops a run filing work that starts more runs.' },
  { key: 'policy.max_children_per_item', type: 'integer', min: 0, max: 100, summary: 'Cap on children one item may create.' },
  { key: 'policy.max_depth', type: 'integer', min: 1, max: 10, summary: 'How deep agent-created work may nest.' },
  { key: 'policy.triage_required_for', type: 'list', allowEmpty: true, summary: 'Actor kinds whose created items are held for triage. Use [] for no policy holds.' },
  { key: 'guard.enabled', type: 'boolean', summary: 'Gate commits on the board. Off means every commit is allowed through.', danger: 'This is the only check that a commit is accounted for on the board.' },
  { key: 'guard.mode', type: 'string', choices: ['block', 'warn'], summary: 'block refuses an unaccounted commit; warn reports it and lets it through.', danger: 'warn reports and allows the commit.' },
  { key: 'guard.accept', type: 'list', summary: 'Evidence the guard accepts, in order: message, branch, owner.' },
  { key: 'guard.exempt_paths', type: 'list', allowEmpty: true, summary: 'Paths the guard ignores when accounting a commit.', danger: 'Every path listed here is invisible to the guard.' },
  { key: 'id_scheme', type: 'string', choices: ['phase-seq', 'seq'], summary: 'phase-seq gives P1-01; seq gives T-0001.' },
  { key: 'brief.max_lines', type: 'integer', min: 4, max: 200, summary: 'Line budget for `gw brief`.' },
  { key: 'check.stale_days', type: 'integer', min: 1, max: 365, summary: 'Days without movement before `gw check` reports an item stale.' },
  { key: 'check.stale_exempt_stages', type: 'list', allowEmpty: true, summary: 'Stages `gw check` never reports stale.' },
  { key: 'memory.enabled', type: 'boolean', summary: 'Recall prior context into prompts and remember completed work.' },
  { key: 'memory.provider', type: 'string', summary: 'Which entry in memory.providers to invoke.', choicesFrom: (config) => Object.keys(config.memory?.providers ?? {}) },
  { key: 'memory.project_id', type: 'string', summary: 'Prompt-capsule id passed to the memory provider on dispatch.' },
  { key: 'memory.recall.on_dispatch', type: 'boolean', summary: 'Recall prior context into the prompt when a run starts.' },
  { key: 'memory.recall.top_k', type: 'integer', min: 1, max: 50, summary: 'How many recalled memories to include.' },
  { key: 'memory.recall.max_chars', type: 'integer', min: 1, max: 100000, summary: 'Character cap on recalled context in a prompt.' },
  { key: 'memory.remember.on_run_ok', type: 'boolean', summary: 'Remember completed work when a run ends ok.' },
  { key: 'memory.remember.on_close', type: 'boolean', summary: 'Remember completed work when an item reaches the closing stage.' },
  { key: 'memory.remember.max_chars', type: 'integer', min: 1, max: 100000, summary: 'Character cap on a stored memory.' },
  { key: 'memory.remember.extra_tags', type: 'list', allowEmpty: true, summary: 'Extra tags added to every stored memory.' },
  // Without this the board never polls GitHub, however true github.enabled is:
  // the sync controller needs an interval as well as a repo. It was settable
  // only by hand-editing the file `gw config` exists so you never have to.
  { key: 'github.enabled', type: 'boolean', summary: 'Pull linked GitHub issues and push comments.' },
  { key: 'github.repo', type: 'string', summary: 'owner/name of the linked GitHub repository.' },
  { key: 'github.sync_interval_min', type: 'integer', min: 1, max: 1440, summary: 'Minutes between automatic syncs while `gw serve` runs.' },
  { key: 'github.dispatch_label', type: 'string', summary: 'Issue label that queues the linked item for dispatch.' },
  { key: 'github.mirror_children', type: 'boolean', summary: 'Comment agent-created children on the parent issue.' },
  { key: 'github.comment_on_move', type: 'boolean', summary: 'Comment on the linked issue when the item moves stage.' },
  { key: 'github.close_on', type: 'string', summary: 'Stage that closes the linked issue on the next sync.' },
  { key: 'github.milestone_to', type: 'string', summary: 'Vocab field GitHub milestones map onto, such as phase.' },
  // List settings are edited as comma-separated values. These are the ones a
  // user genuinely outgrows the defaults on: a team with different phase names
  // or an extra work type should not have to open a JSON file to say so, since
  // the instruction block tells every agent never to do exactly that.
  { key: 'vocab.phase', type: 'list', summary: 'Allowed --phase values, in order. Comma-separated.' },
  { key: 'vocab.priority', type: 'list', summary: 'Allowed --priority values, most urgent first.' },
  { key: 'vocab.type', type: 'list', summary: 'Allowed --type values.' },
];

// The leaves and subtrees of config.json that deliberately have NO SETTINGS
// entry, with the reason each one is file-only. This list is what keeps the
// exclusion honest: the coverage test in test/settings-coverage.test.js walks
// templates/config.json and fails if a scalar or list leaf is neither here
// nor in SETTINGS, so a key added to the template next month cannot silently
// become unreachable by `gw config`.
//
// runner.providers and memory.providers are structures of commands and
// endpoints rather than values; github.labels maps GitHub labels onto several
// fields at once; version is the config schema version that `gw upgrade`
// owns. Declaring any of them as a settable scalar would mean either a key
// that cannot be coerced or an editor that interrogates a human about a
// nested object -- both worse than pointing at the file.
export const FILE_ONLY = [
  { key: 'github.labels', reason: 'a label-to-field map, not a value' },
  { key: 'memory.providers', reason: 'a structure of endpoints, not a value' },
  { key: 'runner.providers', reason: 'a structure of commands, not a value' },
  { key: 'version', reason: 'the config schema version; `gw upgrade` owns it' },
  // glossary.<field>.<code> IS settable -- one description per entry, through
  // the key form handled in lib/commands/config.js -- but the map itself is
  // keyed by the user's own vocabulary, so no fixed SETTINGS entry can name
  // it. The reason text is what `gw config` points at instead.
  { key: 'glossary', reason: 'descriptions are set per entry with `gw config glossary.<field>.<code> "..."`' },
];

// Glossary entries do not live in SETTINGS, and that is deliberate.
//
// A SETTINGS entry is one fixed key with one value, which is what both
// consumers assume: `gw config --list` prints the list once, and the
// interactive editor walks it start to finish asking one question per entry.
// `config.glossary` is a map whose keys are the user's own vocab — it grows
// every time someone adds a code — so declaring it there would mean either a
// key that cannot be enumerated or an editor that interrogates a human about
// every code on their board. Both are worse than the alternative.
//
// So the key form `glossary.<field>.<code>` is parsed instead, and handled in
// lib/commands/config.js. `gw config glossary.phase.P1 "..."` sets one
// description, `gw config glossary.phase.P1` reads it back, and an empty value
// removes it. Descriptions are free text: there is nothing to coerce and
// nothing to validate beyond the field name, because help text has no wrong
// answers.
export function parseGlossaryKey(key) {
  const parts = String(key).split('.');
  if (parts.length !== 3 || parts[0] !== 'glossary') return null;
  const [, field, code] = parts;
  if (!field || !code) return null;
  return { field, code };
}

// The one place that decides whether `glossary.<field>.<code>` names a field
// worth writing to. Both the read path (a lookup of a key that turns out to
// name nothing) and the write path below call this, so the CLI and the serve
// endpoint refuse the same unknown field with the same sentence.
export function glossaryFieldError({ field, code }) {
  if (GLOSSARY_FIELDS.includes(field)) return null;
  return `glossary.${field}.${code} names an unknown vocab field: ${field}\nglossary entries describe one of: ${GLOSSARY_FIELDS.join(', ')}`;
}

// Sets or removes one glossary entry directly on `config` (mutated in place,
// same as setValue). This is the ONLY place that writes config.glossary: `gw
// config glossary.<field>.<code> "..."` and `POST /api/config` both call it,
// so a board using the serve endpoint cannot legally write something the CLI
// would refuse, or vice versa. Returns `{ error }` on a bad field name, never
// throws -- same contract as coerce() -- so both callers can turn it into
// whichever error type fits their surface.
export function applyGlossaryEntry(config, target, rawValue) {
  const { field, code } = target;
  const key = `glossary.${field}.${code}`;
  const error = glossaryFieldError(target);
  if (error) return { key, error };
  const description = String(rawValue ?? '').trim();
  if (config.glossary === null || typeof config.glossary !== 'object' || Array.isArray(config.glossary)) config.glossary = {};
  const entries = config.glossary[field];
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) config.glossary[field] = {};
  if (description) {
    config.glossary[field][code] = description;
  } else {
    // An empty value removes the entry rather than storing a blank one: a
    // description that says nothing is worse than no description.
    delete config.glossary[field][code];
  }
  const vocab = config.vocab?.[field];
  const warning = description && Array.isArray(vocab) && !vocab.includes(code)
    ? `Note: ${code} is not in vocab.${field}, so nothing on the board will show this yet.`
    : null;
  return { key, description, removed: !description, warning };
}

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

export function getValue(config, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), config);
}

export function setValue(config, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let node = config;
  for (const part of parts) {
    if (node[part] == null || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[last] = value;
  return config;
}

// Returns { value } or { error }. Never throws: both `gw config` and the
// wizard want to re-ask rather than abort, and a thrown error in a prompt loop
// reads as a crash.
export function coerce(setting, raw) {
  if (setting.type === 'boolean') {
    const text = String(raw).trim().toLowerCase();
    if (['true', 'yes', 'y', 'on', '1'].includes(text)) return { value: true };
    if (['false', 'no', 'n', 'off', '0'].includes(text)) return { value: false };
    return { error: `${setting.key} is a boolean: use true or false` };
  }
  if (setting.type === 'integer') {
    const value = Number(String(raw).trim());
    if (!Number.isInteger(value)) return { error: `${setting.key} must be a whole number` };
    if (setting.min !== undefined && value < setting.min) return { error: `${setting.key} must be at least ${setting.min}` };
    if (setting.max !== undefined && value > setting.max) return { error: `${setting.key} must be at most ${setting.max}` };
    return { value };
  }
  if (setting.type === 'list') {
    const values = String(raw).split(',').map((entry) => entry.trim()).filter(Boolean);
    if (!values.length) {
      if (setting.allowEmpty && String(raw).trim() === '') return { value: [] };
      return { error: `${setting.key} needs at least one value` };
    }
    const duplicate = values.find((entry, index) => values.indexOf(entry) !== index);
    if (duplicate) return { error: `${setting.key} lists ${JSON.stringify(duplicate)} twice` };
    return { value: values };
  }
  const value = String(raw).trim();
  if (setting.choices && !setting.choices.includes(value)) {
    return { error: `${setting.key} must be one of: ${setting.choices.join(', ')}` };
  }
  return { value };
}

// T-0043's list coercion, moved here from lib/commands/config.js so that `gw
// config` and POST /api/config share one implementation rather than two that
// agree until they drift. `gw config vocab.type` prints the value with
// JSON.stringify, as `["decision","defect",...]`. Pasting that exact form
// back used to be comma-split without validation, storing strings with
// embedded quotes — and every later `--type doc` was then refused while the
// same command listed `doc` as allowed. So the bracketed form the command
// itself prints is accepted here, as a JSON array of non-empty strings,
// validated before it is stored. Anything bracket-shaped that is not that is
// refused with the expected syntax named, rather than silently mangled. The
// plain comma-separated form (`decision,defect,...`) keeps working through
// coerce.
export function coerceList(setting, raw) {
  const text = String(raw).trim();
  const syntax = `expected a JSON array of strings like ["a","b"], or a comma-separated list like a,b`;
  // Any bracket-shaped value goes through the JSON path: an unterminated
  // bracket or a pasted object is a paste error, and comma-splitting it back
  // into garbage is exactly the bug this fixes.
  if (!text.startsWith('[') && !text.startsWith('{')) return coerce(setting, raw);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: `${setting.key}: that bracketed value is not valid JSON. ${syntax}` };
  }
  if (!Array.isArray(parsed) || (!parsed.length && !setting.allowEmpty) || !parsed.every((entry) => typeof entry === 'string' && entry.trim())) {
    return { error: `${setting.key}: a bracketed value must be a JSON array of non-empty strings. ${syntax}` };
  }
  const duplicate = parsed.find((entry, index) => parsed.indexOf(entry) !== index);
  if (duplicate) return { error: `${setting.key} lists ${JSON.stringify(duplicate)} twice` };
  return { value: parsed };
}

// The one entry point both surfaces call for any setting type. Every place
// that turns a raw user-supplied value into a setting value — `gw config`
// scripted and interactive, and the serve endpoint — goes through this, so
// the acceptance and the refusal wording cannot diverge between them.
export function coerceSetting(setting, raw) {
  return setting.type === 'list' ? coerceList(setting, raw) : coerce(setting, raw);
}
