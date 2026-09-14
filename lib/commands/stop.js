import { UsageError } from '../cli/errors.js';
import { createRunLifecycle } from '../run/lifecycle.js';

export const spec = { summary: 'stop one run, or every recorded run offline', flags: { all: { type: 'boolean' } }, positionals: [{ name: 'id', required: false }] };

export async function run(ctx) {
  const [id] = ctx.positionals;
  if (ctx.flags.all && id) throw new UsageError('use either `gw stop <id>` or `gw stop --all`');
  if (!ctx.flags.all && !id) throw new UsageError('usage: gw stop <id> | gw stop --all');
  const lifecycle = createRunLifecycle({ store: ctx.store });
  const results = ctx.flags.all ? await lifecycle.stopAll() : await lifecycle.stopItem(id);
  ctx.stdout.write(`gw stop: ${results.filter((result) => result.status === 'stopped').length} run(s) stopped.\n`);
}
