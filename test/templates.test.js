import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BLOCK_TARGETS, templatePath, readTemplate, upsertBlock } from '../lib/templates.js';

const START = '<!-- gatewright:start -->';
const END = '<!-- gatewright:end -->';

// Extract the fenced block under a specs.md heading. The templates are supposed
// to be byte-exact copies of these blocks, so the spec itself is the oracle.
function specBlock(heading, fence) {
  const specs = readFileSync(new URL('../specs.md', import.meta.url), 'utf8');
  const at = specs.indexOf(heading);
  assert.ok(at !== -1, `specs.md must still contain "${heading}"`);
  const open = specs.indexOf(fence, at);
  const from = specs.indexOf('\n', open) + 1;
  const close = specs.indexOf('\n```', from);
  return specs.slice(from, close) + '\n';
}

test('templates/stages.json is a byte-exact copy of the default stages in specs.md §4', () => {
  assert.equal(readTemplate('stages.json'), specBlock('## 4. stages.json', '```json'));
  assert.equal(readTemplate('stages.json'), readFileSync(templatePath('stages.json'), 'utf8'));
});

test('templates/config.json is a byte-exact copy of the default config in specs.md §5', () => {
  assert.equal(readTemplate('config.json'), specBlock('## 5. config.json', '```json'));
  assert.equal(readTemplate('config.json'), readFileSync(templatePath('config.json'), 'utf8'));
});

test('templates/agents-block.md is a byte-exact copy of the AGENTS.md block in specs.md §11', () => {
  assert.equal(readTemplate('agents-block.md'), specBlock('## 11. AGENTS.md block', '```'));
  assert.match(readTemplate('agents-block.md'), new RegExp(`^${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  assert.match(readTemplate('agents-block.md'), new RegExp(`${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n$`));
});

test('stages.json parses: pipeline order, auto gates, terminal and side states match the spec default', () => {
  const parsed = JSON.parse(readTemplate('stages.json'));
  assert.deepEqual(parsed.stages.map((s) => s.id), ['backlog', 'building', 'built', 'in_review', 'reviewed', 'merged', 'verified']);
  assert.deepEqual(parsed.stages.map((s) => s.label), ['Backlog', 'Building', 'Built', 'In review', 'Reviewed', 'Merged', 'Verified']);
  const auto = Object.fromEntries(parsed.stages.map((s) => [s.id, s.auto === true]));
  assert.deepEqual(auto, { backlog: false, building: true, built: true, in_review: true, reviewed: false, merged: false, verified: false });
  assert.equal(parsed.stages.find((s) => s.id === 'in_review').exit, 'PR opened and reviewer assigned.');
  assert.deepEqual(parsed.terminal, ['verified', 'dropped']);
  assert.deepEqual(parsed.extra.map((s) => s.id), ['dropped', 'paused']);
});

test('every evidence_match in stages.json is a valid RegExp source that gates PR URLs', () => {
  const { stages } = JSON.parse(readTemplate('stages.json'));
  const matches = stages.flatMap((s) => Object.keys(s.requires ?? {}).includes('evidence_match') ? [s.requires.evidence_match] : []);
  assert.equal(matches.length, 1);
  for (const source of matches) {
    let re;
    try { re = new RegExp(source); } catch (err) { assert.fail(`evidence_match is not a valid RegExp source: ${source} (${err.message})`); }
    assert.equal(re.test('https://github.com/acme/app/pull/12'), true, source);
    assert.equal(re.test('https://example.com/pr/12'), false, source);
  }
});

test('every deps_at_least in stages.json names a real stage', () => {
  const { stages, extra } = JSON.parse(readTemplate('stages.json'));
  const ids = stages.map((s) => s.id).concat(extra.map((s) => s.id));
  const refs = stages.flatMap((s) => Object.keys(s.requires ?? {}).includes('deps_at_least') ? [s.requires.deps_at_least] : []);
  assert.deepEqual(refs, ['built', 'merged']);
  for (const ref of refs) assert.ok(ids.includes(ref), `deps_at_least names unknown stage: ${ref}`);
});

test('config.json ships the ordered priority vocab, stale_days, tick_s, and disabled github and memory blocks', () => {
  const parsed = JSON.parse(readTemplate('config.json'));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.id_scheme, 'seq');
  assert.deepEqual(parsed.vocab.priority, ['P0', 'P1', 'P2', 'P3']);
  assert.equal(parsed.check.stale_days, 7);
  assert.equal(parsed.runner.tick_s, 5);
  assert.equal(parsed.runner.prompt_template, '.gatewright/prompt.md');
  assert.equal(parsed.github.enabled, false);
  assert.equal(parsed.memory.enabled, false);
});

test('prompt.md carries exactly the ten spec placeholders and stays under 40 lines', () => {
  const content = readTemplate('prompt.md');
  const names = [...content.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(names)].sort(), ['capsule', 'deps', 'exit', 'log_tail', 'notes', 'prior_context', 'scope', 'stage', 'target_stage', 'title'].sort());
  assert.ok(content.split('\n').length < 40, `prompt.md must stay under 40 lines, got ${content.split('\n').length}`);
});

test('prompt.md tells the agent the item, what done means, the target stage, its exit rule, and to record evidence with gw move', () => {
  const content = readTemplate('prompt.md');
  assert.match(content, /Done means: \{\{scope\}\}/);
  assert.match(content, /\{\{target_stage\}\}/);
  assert.match(content, /\{\{exit\}\}/);
  assert.match(content, /gw move/);
  assert.match(content, /--evidence/);
  assert.match(content, /\{\{prior_context\}\}/);
  assert.match(content, /\{\{capsule\}\}/);
  assert.match(content, /may be empty/i);
});

test('upsertBlock replaces the fenced block in place, preserving everything around it', () => {
  const blockA = `${START}\n## Work tracking\nold rules\n${END}`;
  const blockB = `${START}\n## Work tracking\nnew rules\n${END}`;
  const existing = `Header text.\n\n${blockA}\n\nFooter text.\n`;
  assert.equal(upsertBlock(existing, blockB), `Header text.\n\n${blockB}\n\nFooter text.\n`);
});

test('upsertBlock appends the block with exactly one blank line before it, and nothing before an empty file', () => {
  const block = `${START}\n## Work tracking\nrules\n${END}`;
  assert.equal(upsertBlock('', block), block);
  assert.equal(upsertBlock('Some existing AGENTS.md.\n', block), `Some existing AGENTS.md.\n\n${block}`);
  assert.equal(upsertBlock('No trailing newline', block), `No trailing newline\n\n${block}`);
});

test('upsertBlock normalizes a ragged tail to exactly one blank line', () => {
  const block = `${START}\n## Work tracking\nrules\n${END}`;
  assert.equal(upsertBlock(`Text.\n\n\n\n`, block), `Text.\n\n${block}`);
});

test('upsertBlock is idempotent on both the append and replace paths', () => {
  const block = readTemplate('agents-block.md');
  const appended = upsertBlock('Existing rules file.\n', block);
  assert.equal(upsertBlock(appended, block), appended);
  assert.equal(upsertBlock(block, block), block);
  const editedBlock = block.replace('act on it.', 'act on it. Be excellent to each other.');
  const replaced = upsertBlock(appended, editedBlock);
  assert.equal(upsertBlock(replaced, editedBlock), replaced);
});

test('upsertBlock throws a clear error instead of corrupting a malformed AGENTS.md', () => {
  const block = `${START}\n## Work tracking\nrules\n${END}`;
  assert.throws(() => upsertBlock(`${START}\nrules with no end marker\n`, block), /start.*no.*end|end marker/i);
  assert.throws(() => upsertBlock(`stray end marker\n${END}\n`, block), /end.*no.*start|start marker/i);
  assert.throws(() => upsertBlock(`${END}\n${START}\nreversed\n`, block), /out of order|before/i);
  assert.throws(
    () => upsertBlock(`${START}\none\n${START}\ntwo\n${END}\n`, block),
    (err) => /exactly one/.test(err.message),
  );
});

test('mirror invitation metadata only treats provider-owned directories as evidence', () => {
  assert.deepEqual(
    Object.fromEntries(BLOCK_TARGETS.map((target) => [target.name, target.parent])),
    { claude: null, cursor: '.cursor/rules', copilot: null },
  );
});
