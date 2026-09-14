export const spec = { flags: { stage: { type: 'string' }, phase: { type: 'string' }, flag: { type: 'string' }, json: { type: 'boolean' } } };

export function run(ctx) {
  const items = ctx.store.readItems().filter((item) => (!ctx.flags.stage || item.stage === ctx.flags.stage) && (!ctx.flags.phase || item.phase === ctx.flags.phase) && (!ctx.flags.flag || item.flag === ctx.flags.flag));
  if (ctx.flags.json) { ctx.stdout.write(`${JSON.stringify(items)}\n`); return; }
  for (const item of items) ctx.stdout.write(`${item.id}  ${item.stage ?? '-'}  ${item.title ?? ''}\n`);
}
