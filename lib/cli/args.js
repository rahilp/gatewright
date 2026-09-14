import { UsageError } from './errors.js';

export function parseArgs(argv, spec) {
  const flags = {};
  const positionals = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!positionalOnly && arg === '--') { positionalOnly = true; continue; }
    if (!positionalOnly && arg.startsWith('--') && arg.length > 2) {
      const equals = arg.indexOf('=');
      const name = arg.slice(2, equals === -1 ? undefined : equals);
      const definition = spec.flags?.[name];
      if (!definition) throw new UsageError(`unknown flag: --${name}`);
      let value;
      if (definition.type === 'boolean') {
        if (equals !== -1) throw new UsageError(`boolean flag does not take a value: --${name}`);
        value = true;
      } else {
        value = equals === -1 ? argv[++i] : arg.slice(equals + 1);
        if (value === undefined || value === '' || (equals === -1 && value.startsWith('--'))) throw new UsageError(`flag --${name} needs a value`);
      }
      if (definition.repeat) (flags[name] ??= []).push(value);
      else flags[name] = value;
    } else positionals.push(arg);
  }
  for (let i = 0; i < (spec.positionals?.length ?? 0); i += 1) {
    if (spec.positionals[i].required && positionals[i] === undefined) throw new UsageError(`missing required positional: ${spec.positionals[i].name}`);
  }
  return { positionals, flags };
}
