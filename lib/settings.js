// The settings a user is expected to change, declared once.
//
// This list is the single source of truth for `gw config` and for the `gw
// init` wizard, so the two cannot drift into disagreeing about what a valid
// setting is. It deliberately does not cover everything in config.json:
// `runner.providers`, vocabularies and prompt paths are structures, not
// scalars, and pretending a nested object is a settable key produces a worse
// experience than sending someone to the file.
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
  { key: 'policy.auto_dispatch_children', type: 'boolean', summary: 'Whether agent-created children dispatch without a human.', danger: 'Leaving this off is what stops a run filing work that starts more runs.' },
  { key: 'policy.max_children_per_item', type: 'integer', min: 0, max: 100, summary: 'Cap on children one item may create.' },
  { key: 'policy.max_depth', type: 'integer', min: 1, max: 10, summary: 'How deep agent-created work may nest.' },
  { key: 'id_scheme', type: 'string', choices: ['phase-seq', 'seq'], summary: 'phase-seq gives P1-01; seq gives T-0001.' },
  { key: 'memory.enabled', type: 'boolean', summary: 'Recall prior context into prompts and remember completed work.' },
  // List settings are edited as comma-separated values. These are the ones a
  // user genuinely outgrows the defaults on: a team with different phase names
  // or an extra work type should not have to open a JSON file to say so, since
  // the instruction block tells every agent never to do exactly that.
  { key: 'vocab.phase', type: 'list', summary: 'Allowed --phase values, in order. Comma-separated.' },
  { key: 'vocab.priority', type: 'list', summary: 'Allowed --priority values, most urgent first.' },
  { key: 'vocab.gate', type: 'list', summary: 'Allowed --gate values.' },
  { key: 'vocab.type', type: 'list', summary: 'Allowed --type values.' },
];

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
    if (!values.length) return { error: `${setting.key} needs at least one value` };
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
