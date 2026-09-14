// The sole boundary for Git commands.  Like the gh wrapper, callers inject
// argv-shaped `run` functions in tests so board tests never touch a checkout.
import { execFileSync } from 'node:child_process';

function defaultRun(argv, options = {}) {
  const stdout = execFileSync('git', argv, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { stdout, status: 0 };
}

export function createGit({ run = defaultRun } = {}) {
  return {
    run(argv, options) {
      try {
        const result = run(argv, options);
        if (!result || result.status !== 0) throw new Error(result?.stderr || 'git command failed');
        return result;
      } catch (error) {
        throw new Error(`git ${argv.join(' ')} failed: ${error.message}`);
      }
    },
  };
}
