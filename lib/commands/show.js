import { UsageError } from '../cli/errors.js';

export const spec = { flags: { json: { type: 'boolean' } }, positionals: [{ name: 'id', required: true }] };

export function run(ctx) {
  const id = ctx.positionals[0];
  const item = ctx.store.readItems().find((candidate) => candidate.id === id);
  if (!item) throw new UsageError(`unknown item: ${id}`);
  if (ctx.flags.json) { ctx.stdout.write(`${JSON.stringify(item)}\n`); return; }
  ctx.stdout.write(`${Object.entries(item).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n')}\n\nevents:\n`);
  for (const event of ctx.store.readEvents().filter((event) => event.item === id)) ctx.stdout.write(`  ${JSON.stringify(event)}\n`);
}
