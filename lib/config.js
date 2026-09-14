import { existsSync, readFileSync } from 'node:fs';
import { IOError } from './cli/errors.js';

const DEFAULT_STAGES = {
  stages: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'specified', label: 'Specified', exit: 'Someone picks it up and starts changing code or the owning document.', auto: true },
    { id: 'building', label: 'Building', exit: 'Change is complete locally with tests passing.', auto: true, requires: { owner: true } },
    { id: 'built', label: 'Built', exit: 'Evidence recorded: commit and test path.', auto: true, requires: { evidence_min: 1, deps_at_least: 'built' } },
    { id: 'in_review', label: 'In review', exit: 'PR opened and reviewer assigned.', auto: true, requires: { evidence_match: '^https://github.com/.+/pull/\\d+' } },
    { id: 'reviewed', label: 'Reviewed', exit: 'Reviewer approved.', auto: false },
    { id: 'merged', label: 'Merged', exit: 'PR merged to main.', auto: false, requires: { deps_at_least: 'merged' } },
    { id: 'verified', label: 'Verified', exit: 'Behaviour confirmed on target; VALIDATION entry linked.', auto: false, requires: { evidence_min: 2 } },
  ], terminal: ['verified', 'dropped'], extra: [{ id: 'dropped', label: 'Dropped' }, { id: 'paused', label: 'Paused' }],
};

const DEFAULT_CONFIG = {
  version: 1, id_scheme: 'phase-seq',
  vocab: { phase: ['P0', 'P1', 'P2', 'P3'], priority: ['P0', 'P1', 'P2', 'P3'], gate: ['G0', 'G1', 'G2'], type: ['decision', 'defect', 'feature', 'test', 'doc'] },
  brief: { max_lines: 25 }, check: { stale_days: 7 },
  github: { enabled: false, repo: null, dispatch_label: 'agent/go', mirror_children: false, comment_on_move: true, close_on: 'verified', labels: { 'priority/P0': { priority: 'P0' }, 'type/defect': { type: 'defect' }, 'phase/2': { phase: 'P2' } }, milestone_to: 'gate' },
  runner: { provider: 'claude', providers: { claude: { cmd: ['claude', '-p', '{prompt}', '--allowedTools', 'Edit,Bash'] }, codex: { cmd: ['codex', 'exec', '{prompt}'] }, custom: { cmd: ['./scripts/run-agent.sh', '{item}'] } }, prompt_template: '.gatewright/prompt.md', tick_s: 5, max_concurrent: 1, stop_timeout_s: 30, run_timeout_min: 60, worktree_root: '.gatewright/.worktrees', paused: false },
  policy: { auto_dispatch_children: false, max_children_per_item: 10, triage_required_for: ['agent'] },
  memory: { enabled: false, provider: 'second-brain', providers: { 'second-brain': { url: 'https://second-brain.example.workers.dev/mcp', token_env: 'SECOND_BRAIN_TOKEN' } }, project_id: null, recall: { on_dispatch: true, top_k: 5, max_chars: 2000 }, remember: { on_run_ok: true, on_close: true, max_chars: 800, extra_tags: [] } },
};

function readJson(path, fallback) {
  if (!existsSync(path)) return structuredClone(fallback);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new IOError(`${path.split('/').pop()} is not valid JSON.`); }
}
export function readConfig(store) { return readJson(store.paths.config, DEFAULT_CONFIG); }
export function readStages(store) { return readJson(store.paths.stages, DEFAULT_STAGES); }
