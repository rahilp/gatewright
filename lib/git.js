// The sole boundary for Git commands.  Like the gh wrapper, callers inject
// argv-shaped `run` functions in tests so board tests never touch a checkout.
import { execFileSync } from 'node:child_process';

// Every call through this boundary is a local, no-network git operation
// (worktree add/list, show-ref, status) that is normally sub-second even on
// a large repo. Bounded anyway: an unbounded execFileSync is the same class
// of bug this project already fixed for taskkill/Get-Process and gh (see
// specs.md §10.2) — a stalled network filesystem under .git, or a git hook
// that prompts, would otherwise hang every command that touches a worktree.
const DEFAULT_GIT_TIMEOUT_MS = 10_000;

function defaultRun(argv, options = {}) {
  const stdout = execFileSync('git', argv, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEFAULT_GIT_TIMEOUT_MS,
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
