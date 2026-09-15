import { IOError, UsageError } from '../cli/errors.js';
import { createRunLifecycle } from '../run/lifecycle.js';

export const spec = { summary: 'stop one run, or every recorded run offline', flags: { all: { type: 'boolean' } }, positionals: [{ name: 'id', required: false }] };

export async function run(ctx) {
  const [id] = ctx.positionals;
  if (ctx.flags.all && id) throw new UsageError('use either `gw stop <id>` or `gw stop --all`');
  if (!ctx.flags.all && !id) throw new UsageError('usage: gw stop <id> | gw stop --all');
  const lifecycle = createRunLifecycle({ store: ctx.store });
  const results = ctx.flags.all ? await lifecycle.stopAll() : await lifecycle.stopItem(id);
  const unconfirmed = results.filter((result) => result.status === 'stop_unconfirmed');
  ctx.stdout.write(`gw stop: ${results.filter((result) => result.status === 'stopped').length} run(s) stopped.\n`);
  if (unconfirmed.length) {
    // Not a UsageError or RuleError: nothing the caller typed was wrong, an
    // external command (taskkill/Get-Process) just didn't answer in time.
    // The run stays registered and untouched — see lifecycle.js's end() —
    // so this is real, actionable signal for a script or human watching the
    // kill switch, not a cosmetic warning to swallow.
    throw new IOError(`gw stop: ${unconfirmed.length} run(s) could not be confirmed stopped (no response from the OS in time); they remain tracked and may still be running. Retry \`gw stop\`.`);
  }
}
