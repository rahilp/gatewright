import { stageList } from '../rules.js';

// The board is read by humans who never see stages.json. A gate they cannot
// read is a gate they cannot trust, so every rule key in lib/rules.js gets a
// sentence here, and anything this module does not recognise says so out loud
// rather than vanishing: a silently dropped rule is how a board ends up lying
// about what it enforces.

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten',
];

// Small counts read better as words; past ten the word is the harder parse.
function count(value) {
  return NUMBER_WORDS[value] ?? String(value);
}

function stageLabel(stages, stageId) {
  const stage = stageList(stages ?? {}).find((candidate) => candidate.id === stageId);
  return stage?.label ?? String(stageId);
}

// The shipped `in_review` gate is a GitHub pull request URL pattern. Printing
// that regex at a human is not an explanation, so name the intent instead and
// keep the raw-pattern wording for genuinely custom regexes.
function isPullRequestPattern(pattern) {
  const source = String(pattern);
  return /github\.com/i.test(source) && /pull/i.test(source);
}

/**
 * One rule, one sentence. Returns null when the rule is inert (`owner: false`,
 * `evidence_min: 0`), because a rule that enforces nothing should not appear on
 * the board as though it did.
 */
export function describeRule(key, value, stages) {
  switch (key) {
    case 'scope':
      return value ? 'Scope must be filled in' : null;
    case 'owner':
      return value ? 'Someone must have claimed it' : null;
    case 'evidence_min': {
      const minimum = Number(value);
      if (!Number.isFinite(minimum) || minimum <= 0) return null;
      const piece = minimum === 1 ? 'piece' : 'pieces';
      return `Needs at least ${count(minimum)} ${piece} of evidence`;
    }
    case 'evidence_match': {
      if (!value) return null;
      if (isPullRequestPattern(value)) return 'Evidence must include a link to a pull request';
      return `Evidence must match the pattern \`${value}\``;
    }
    case 'deps_at_least': {
      if (!value) return null;
      return `Every dependency must have reached ${stageLabel(stages, value)}`;
    }
    default:
      return `Unrecognised rule "${key}": this board does not check it`;
  }
}

/**
 * Every rule in a stage's `requires`, in plain English. An absent or empty
 * `requires` is itself a statement about the gate, so it gets a sentence too.
 */
export function describeRequires(requires, stages) {
  const entries = Object.entries(requires ?? {});
  if (entries.length === 0) {
    return ['Nothing is checked here: this stage is advanced by hand'];
  }
  const sentences = entries
    .map(([key, value]) => describeRule(key, value, stages))
    .filter((sentence) => sentence !== null);
  if (sentences.length === 0) {
    return ['Nothing is checked here: this stage is advanced by hand'];
  }
  return sentences;
}

/**
 * A stage's gate as sentences plus a single-line summary for a column header.
 */
export function describeStage(stage, stages) {
  const sentences = describeRequires(stage?.requires, stages);
  return { sentences, summary: sentences.join('; ') };
}
