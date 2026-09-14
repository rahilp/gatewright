import { readConfig } from '../config.js';
import { createGh } from '../sync/gh.js';
import { pull } from '../sync/pull.js';
import { UsageError } from '../cli/errors.js';

export const spec = { summary: 'pull linked GitHub issues', flags: { 'dry-run': { type: 'boolean' } }, positionals: [] };

export function run(ctx) {
  const config = readConfig(ctx.store);
  if (!config.github?.enabled || !config.github.repo) {
    throw new UsageError('GitHub sync is not enabled; run `gw init --gh --repo owner/repo`.');
  }
  const dryRun = ctx.flags['dry-run'] === true;
  const gh = createGh({ run: ctx.ghRun, dryRun, repo: config.github.repo });
  pull({ store: ctx.store, gh, dryRun, stdout: ctx.stdout, stderr: ctx.stderr });
  return 0;
}
