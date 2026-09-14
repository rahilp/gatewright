// The sole boundary between Gatewright and the GitHub CLI.  Keep this module
// deliberately boring: sync policy belongs in pull.js and push.js.
import { execFileSync } from 'node:child_process';

const ISSUE_FIELDS = 'number,title,body,labels,milestone,state,updatedAt,url';

function defaultRun(argv) {
  const stdout = execFileSync('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { stdout, status: 0 };
}

function unavailable(error) {
  if (error?.code === 'ENOENT') {
    return new Error('GitHub CLI (gh) is not installed. Install gh, then run `gh auth login`.');
  }
  return new Error('GitHub CLI is not authenticated. Run `gh auth login`.');
}

function json(run, argv) {
  let result;
  try {
    result = run(argv);
  } catch (error) {
    throw unavailable(error);
  }
  if (result.status !== 0) throw unavailable();
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('GitHub CLI returned invalid JSON.');
  }
}

// `run` receives argv without the leading `gh`, making fixture stubs tiny.
// It returns { stdout, status }, where status is the gh process exit status.
export function createGh({ run = defaultRun, dryRun = false, repo }) {
  function write(argv) {
    if (dryRun) {
      console.log(`gh ${argv.join(' ')}`);
      return undefined;
    }
    try {
      const result = run(argv);
      if (result.status !== 0) throw unavailable();
      return result;
    } catch (error) {
      if (error.message?.includes('gh auth login')) throw error;
      throw unavailable(error);
    }
  }

  return {
    issues({ since } = {}) {
      const search = `updated:>=${since ?? '1970-01-01T00:00:00Z'}`;
      return json(run, ['issue', 'list', '--repo', repo, '--state', 'all', '--search', search, '--json', ISSUE_FIELDS, '--limit', '200']);
    },
    comment(number, body) {
      return write(['issue', 'comment', String(number), '--repo', repo, '--body', body]);
    },
    close(number) {
      return write(['issue', 'close', String(number), '--repo', repo]);
    },
    editLabels(number, { add = [], remove = [] } = {}) {
      return write(['issue', 'edit', String(number), '--repo', repo, ...add.flatMap((label) => ['--add-label', label]), ...remove.flatMap((label) => ['--remove-label', label])]);
    },
    createIssue({ title, body }) {
      // `gh issue create` prints only a URL; the API form returns the JSON
      // record the pusher needs to link the newly-created item.
      const argv = ['api', '--method', 'POST', `repos/${repo}/issues`, '--raw-field', `title=${title}`, '--raw-field', `body=${body}`];
      if (dryRun) return write(argv);
      return json(run, argv);
    },
    authStatus() {
      let result;
      try {
        result = run(['auth', 'status']);
      } catch (error) {
        throw unavailable(error);
      }
      if (result.status !== 0) throw unavailable();
      return { authenticated: true };
    },
  };
}
