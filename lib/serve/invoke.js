// HTTP writes use this adapter rather than duplicating command behaviour in
// the server. Keep this ctx in lockstep with lib/cli/router.js.
import { UsageError } from '../cli/errors.js';

function buffer() {
  let value = '';
  return { write: (chunk) => { value += String(chunk); }, get value() { return value; } };
}

export async function invoke(commandName, {
  flags = {}, positionals = [], store, root = store.root, actor,
  env = process.env, cwd = root,
} = {}) {
  const command = await import(new URL(`../commands/${commandName}.js`, import.meta.url));
  for (let i = 0; i < (command.spec.positionals?.length ?? 0); i += 1) {
    if (command.spec.positionals[i].required && positionals[i] === undefined) {
      throw new UsageError(`missing required positional: ${command.spec.positionals[i].name}`);
    }
  }
  const stdout = buffer();
  const stderr = buffer();
  const ctx = { flags, positionals, store, root, actor, env, cwd, stdout, stderr };
  const code = (await command.run(ctx)) ?? 0;
  return { code, stdout: stdout.value, stderr: stderr.value };
}
