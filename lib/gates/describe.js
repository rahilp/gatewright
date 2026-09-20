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

// T-0129 — the shape gate the shipped boards put on the stage where work is
// claimed complete: an artifact reference, not a sentence about one. A commit
// SHA (7-64 hex), a link, or a path — either one containing a separator or a
// bare filename with an extension. Whitespace is excluded throughout and the
// whole string is anchored, which is the part that matters: free text cannot
// satisfy it, so a refusal can no longer be answered by pasting the refusal
// back. The three forms are deliberately the same three `gw brief` will hand
// to a memory provider (lib/memory/write.js), so what passes a gate is what
// the tool is willing to repeat elsewhere.
//
// It lives here, beside the sentence that reads it back, so the pattern the
// templates enforce and the English the board prints cannot drift apart;
// test/templates.test.js holds the shipped templates to this exact source.
export const ARTIFACT_EVIDENCE = '^(?:[0-9a-fA-F]{7,64}|[A-Za-z][A-Za-z0-9+.-]*://\\S+|\\S+/\\S*|\\S+\\.[A-Za-z][A-Za-z0-9_-]*)$';

function isArtifactPattern(pattern) {
  return String(pattern) === ARTIFACT_EVIDENCE;
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
      const piece = minimum === 1 ? 'piece of evidence' : 'pieces of evidence';
      // T-0029: a gate counts what this move supplies, distinct from anything
      // already recorded — so the sentence says "new", not a lifetime total.
      return `Needs at least ${count(minimum)} new ${piece}, distinct from anything already recorded`;
    }
    case 'evidence_match': {
      if (!value) return null;
      // The match is judged on what the move supplies, like the minimum.
      const stem = 'Evidence supplied with the move';
      if (isArtifactPattern(value)) return `${stem} must look like a commit, a file path, or a link`;
      if (isPullRequestPattern(value)) return `${stem} must include a link to a pull request`;
      return `${stem} must match the pattern \`${value}\``;
    }
    case 'deps_at_least': {
      if (!value) return null;
      return `Every dependency must have reached ${stageLabel(stages, value)}`;
    }
    case 'children_done':
      return value ? 'Every direct child item must be finished' : null;
    default:
      return `Unrecognised rule "${key}": this board does not check it`;
  }
}

// T-0087 — the placeholder a pattern-gate refusal prints must not promise that
// any evidence would do: `--evidence <e>` on a pattern gate is a command the
// same gate refuses forever. For the shipped pull-request gate the placeholder
// names the one thing that passes; for a custom regex the sentence already
// states the pattern, so the placeholder only says what the text must be.
//
// T-0129 — a gate with no pattern at all gets the same treatment. `--evidence
// "new evidence 1"` was a literal string that passed every count-only gate by
// construction, so the refusal for the product's own differentiator could be
// cleared by pasting the refusal back. The tool never prints evidence that
// would pass: it prints the SHAPE the evidence should have.
function evidenceShape(pattern) {
  if (pattern && isPullRequestPattern(pattern)) return 'pull-request url';
  if (pattern && !isArtifactPattern(pattern)) return 'matching text';
  return 'commit sha, test path, or URL';
}

/**
 * The `--evidence` value a refusal prints, quoted so the printed command runs
 * as printed on both /bin/sh and cmd.exe. `of` is how many flags the command
 * carries: a gate de-duplicates, so several flags have to be several distinct
 * placeholders or the command loops on the refusal it was meant to clear.
 */
export function evidencePlaceholder(pattern, { index = 0, of = 1 } = {}) {
  const shape = evidenceShape(pattern);
  return of > 1 ? `"<${shape} #${index + 1}>"` : `"<${shape}>"`;
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
