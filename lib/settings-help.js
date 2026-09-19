// Plain-English help for each setting, shown in the `gw config` editors.
//
// SETTINGS (lib/settings.js) says what a setting *is*; this says what changing
// it does to the person using the board, in words someone new to Gatewright,
// git, and AI agents can follow. Every sentence here was checked against the
// code that reads the setting -- if that code changes, change the sentence.
//
//   effect  what the setting changes in practice (1-2 short sentences)
//   values  for on/off and fixed-choice settings: what each value does;
//           for lists, `entry` says what one entry means
//   unit    the unit for a number, used in "Allowed: 1–64 agents"
//   danger  a plain-English version of the setting's warning, if it has one
//
// The setting names stay as they are (they are what people type); only the
// explanations are plain.
export const SETTING_HELP = {
  'runner.enabled': {
    danger: 'Turning this on lets the board start programs on your computer that change your files and may cost money.',
    effect: 'Whether `gw serve` may start AI agents on this computer to work on items for you.',
    values: {
      true: 'The board can start agents here. Pressing Play on an item really runs one.',
      false: 'Nothing is started. Pressing Play only puts the item in a queue.',
    },
  },
  'runner.provider': {
    effect: 'Which AI agent program is started when the board runs an item.',
  },
  'runner.max_concurrent': {
    effect: 'The most agents that may work at the same time. More agents means more work in parallel, and more cost.',
    unit: 'agents',
  },
  'runner.tick_s': {
    effect: 'How often `gw serve` checks for queued items to start.',
    unit: 'seconds',
  },
  'runner.run_timeout_min': {
    effect: 'An agent still running after this long is stopped, so a stuck agent cannot run forever.',
    unit: 'minutes',
  },
  'runner.stop_timeout_s': {
    effect: 'When you stop an agent, how long it gets to finish up before it is shut down.',
    unit: 'seconds',
  },
  'runner.paused': {
    effect: 'A pause button for all agents. Your other agent settings stay as they are.',
    values: {
      true: 'No new agents start until you turn this off again.',
      false: 'Agents start as normal.',
    },
  },
  'runner.prompt_template': {
    effect: 'The file with the instructions each agent is given when it starts. The path is relative to your project folder.',
  },
  'runner.worktree_root': {
    effect: 'The folder where each agent gets its own separate copy of your project to work in, so agents do not get in each other\'s way.',
  },
  'policy.auto_dispatch_children': {
    danger: 'Leaving this off is what stops an agent from adding work that starts more agents, over and over.',
    effect: 'Whether new items that an agent adds while working can go ahead without your approval.',
    values: {
      true: 'Items an agent adds skip the approval step, so agents can keep creating and starting more work.',
      false: 'Items an agent adds wait for approval (see policy.triage_required_for).',
    },
  },
  'policy.max_children_per_item': {
    effect: 'The most sub-items that can be added under one item. Adding one more is refused.',
    unit: 'sub-items',
  },
  'policy.max_depth': {
    effect: 'How many levels deep sub-items can go (a sub-item of a sub-item, and so on). Going deeper is refused.',
    unit: 'levels',
  },
  'policy.triage_required_for': {
    effect: 'Whose new items must be approved before anyone can move them forward. Approve one with `gw triage <item> --approve`.',
    values: { entry: 'Each entry is a kind of author, such as agent or human. "agent" means work an AI agent adds waits until someone approves it.' },
  },
  'guard.enabled': {
    danger: 'This is the only check that each commit belongs to an item on the board.',
    effect: 'Whether commits are checked against the board, so every change you commit is tied to an item.',
    values: {
      true: 'Each commit must mention an item, or you must have claimed one. Commits that do not are handled as guard.mode says.',
      false: 'Every commit goes through without any check.',
    },
  },
  'guard.mode': {
    danger: 'With warn, commits that belong to no item still go through.',
    effect: 'What happens to a commit that is not tied to any item on the board.',
    values: {
      block: 'The commit is refused. You can still force it with `git commit --no-verify`.',
      warn: 'The commit goes through, with a warning printed.',
    },
  },
  'guard.accept': {
    effect: 'The ways a commit can show which item it belongs to.',
    values: { entry: 'message = the commit message names an item; branch = the branch name names one; owner = you have claimed an item with `gw claim`.' },
  },
  'guard.exempt_paths': {
    danger: 'Changes to anything listed here are never checked.',
    effect: 'Files and folders the commit check ignores. A commit that only changes these goes through without naming an item.',
    values: { entry: 'Each entry is a path in your project, such as .gatewright/ or docs/.' },
  },
  id_scheme: {
    effect: 'How new items are numbered. Items you already have keep their numbers.',
    values: {
      seq: 'One running count: T-0001, T-0002, and so on.',
      'phase-seq': 'Numbered within a phase: P1-01, P1-02, P2-01. Every new item then needs a phase.',
    },
  },
  'brief.max_lines': {
    effect: 'How long the `gw brief` summary may be. Shorter briefs leave out the less urgent items.',
    unit: 'lines',
  },
  'check.stale_days': {
    effect: '`gw check` reports a claimed item as stalled when nothing has happened to it for this many days.',
    unit: 'days',
  },
  'check.stale_exempt_stages': {
    effect: 'Stages where `gw check` does not look for stalled or problem items, because work there is waiting on purpose.',
    values: { entry: 'Each entry is a stage name from your board, such as merged.' },
  },
  'memory.enabled': {
    effect: 'Whether agents use a memory service to remember past work and recall it on new items.',
    values: {
      true: 'Agents are given related past work when they start, and finished work is saved to memory.',
      false: 'No memory service is contacted.',
    },
  },
  'memory.provider': {
    effect: 'Which memory service is used.',
  },
  'memory.project_id': {
    effect: 'An optional project name to send to the memory service, so it can add notes about this project when an agent starts.',
  },
  'memory.recall.on_dispatch': {
    effect: 'Whether an agent is given related past work when it starts.',
    values: {
      true: 'Past work related to the item is added to the agent\'s instructions.',
      false: 'Agents start with no past work added.',
    },
  },
  'memory.recall.top_k': {
    effect: 'How many past notes an agent is given when it starts.',
    unit: 'notes',
  },
  'memory.recall.max_chars': {
    effect: 'The most text from past notes added to an agent\'s instructions.',
    unit: 'characters',
  },
  'memory.remember.on_run_ok': {
    effect: 'Whether finished work is saved to memory when an agent completes successfully.',
    values: {
      true: 'A short note about the finished item is saved.',
      false: 'Nothing is saved when an agent finishes.',
    },
  },
  'memory.remember.on_close': {
    effect: 'Whether finished work is saved to memory when an item is moved to the stage in github.close_on.',
    values: {
      true: 'A short note is saved when the item reaches that stage.',
      false: 'Nothing is saved at that point.',
    },
  },
  'memory.remember.max_chars': {
    effect: 'The longest note saved to memory for one item.',
    unit: 'characters',
  },
  'memory.remember.extra_tags': {
    effect: 'Extra labels added to every note saved to memory, to help you find them later.',
    values: { entry: 'Each entry is one label, such as my-project.' },
  },
  'github.enabled': {
    effect: 'Whether the board stays in step with GitHub issues while `gw serve` runs.',
    values: {
      true: 'Issues from github.repo are brought onto the board, and board changes are posted back to them.',
      false: 'GitHub is never contacted.',
    },
  },
  'github.repo': {
    effect: 'The GitHub repository to keep in step with, written as owner/name.',
  },
  'github.sync_interval_min': {
    effect: 'How often `gw serve` checks GitHub for changes.',
    unit: 'minutes',
  },
  'github.dispatch_label': {
    effect: 'Put this label on a GitHub issue to have the board start an agent on the matching item.',
  },
  'github.mirror_children': {
    effect: 'Whether a sub-item an agent adds, under an item linked to a GitHub issue, gets a GitHub issue of its own.',
    values: {
      true: 'A new GitHub issue is opened for each such sub-item.',
      false: 'Sub-items stay on the board only.',
    },
  },
  'github.comment_on_move': {
    effect: 'Whether the GitHub issue gets a comment each time its item moves to a new stage.',
    values: {
      true: 'Each move is posted as a comment on the issue.',
      false: 'Moves are not posted to GitHub.',
    },
  },
  'github.close_on': {
    effect: 'When an item reaches this stage, its GitHub issue is closed. Type a stage name from your board.',
  },
  'github.milestone_to': {
    effect: 'Which item field a GitHub milestone fills in. For example, phase turns milestone "P1" into phase P1.',
  },
  'vocab.phase': {
    effect: 'The phases you can give an item with --phase, in order.',
    values: { entry: 'Each entry is one phase name, such as P1 or Beta.' },
  },
  'vocab.priority': {
    effect: 'The priorities you can give an item with --priority, most urgent first. Agents pick up more urgent items first.',
    values: { entry: 'Each entry is one priority name, such as P0 or high.' },
  },
  'vocab.type': {
    effect: 'The kinds of work you can give an item with --type.',
    values: { entry: 'Each entry is one kind, such as feature or bug.' },
  },
};
