import { UsageError } from '../cli/errors.js';
import { createRunLifecycle } from '../run/lifecycle.js';

export const spec = { summary: 'resume a paused item using its existing worktree', flags: {}, positionals: [{ name: 'id', required: true }] };
export function run(ctx) {
  const [id] = ctx.positionals;
  try { createRunLifecycle({ store: ctx.store }).resume(id); } catch (error) { if (/^(unknown item:|item .* is not paused;)/.test(error.message)) throw new UsageError(error.message); throw error; }
  ctx.stdout.write(`gw resume: ${id} dispatched.\n`);
}
