import { basename } from 'node:path';

const SHA = /^[0-9a-f]{7,64}$/i;
const PATH = /^(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+(?:\?[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?$/;
const ROOT_FILE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/;

// Evidence is the one field whose contents commonly originate outside the
// tracker. Keep only the three deliberately boring forms promised by the
// memory contract; arbitrary notes, output and environment values cannot
// enter through this route.
function safeEvidence(value) {
  const text = String(value ?? '').trim();
  if (SHA.test(text) || PATH.test(text) || ROOT_FILE.test(text)) return text;
  try {
    const url = new URL(text);
    return (url.protocol === 'https:' || url.protocol === 'http:') ? url.toString() : null;
  } catch { return null; }
}

function firstLine(value) { return String(value ?? '').split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''; }

function lastNote(notes) {
  const line = String(notes ?? '').split(/\r?\n/).filter((entry) => entry.trim()).at(-1) ?? '';
  return line.replace(/^\[[^\]]+\]\s*/, '').trim();
}

export function memoryRecord({ root, config = {}, item, from, to, commitMessage }) {
  const remember = config.memory?.remember ?? {};
  const repo = config.github?.repo || basename(root);
  const why = (lastNote(item.notes) || firstLine(item.scope)).slice(0, 200);
  const accepted = []; let omitted = 0;
  for (const value of item.evidence ?? []) {
    const safe = safeEvidence(value);
    if (safe) accepted.push(safe); else omitted += 1;
  }
  const prefix = `${repo} · ${item.id} ${item.title ?? ''} · ${from}→${to} · changed: ${firstLine(commitMessage)} · why: ${why} · evidence: `;
  const cap = Number(remember.max_chars) || 800;
  const marker = omitted ? `(+${omitted} evidence omitted)` : '';
  const selected = [];
  for (const entry of accepted) {
    const candidate = [...selected, entry, ...(marker ? [marker] : [])].join(', ');
    if ((prefix.length + candidate.length) > cap) break;
    selected.push(entry);
  }
  const evidence = [...selected, ...(marker ? [marker] : [])].join(', ');
  // The marker is more valuable than a marginal evidence entry: it tells the
  // reader to consult the board when sanitisation or the configured budget
  // made this recall record partial.
  const text = prefix.length + evidence.length <= cap ? `${prefix}${evidence}` : `${prefix.slice(0, Math.max(0, cap - marker.length))}${marker}`;
  return {
    text,
    tags: ['gatewright', repo, item.type ?? 'work', item.phase ?? 'unknown', ...(remember.extra_tags ?? [])],
  };
}

export function rememberCompleted({ memory, root, config, item, from, to, commitMessage, verified = false }) {
  const record = memoryRecord({ root, config, item, from, to, commitMessage });
  if (verified) record.tags.push('verified');
  return memory.remember(record.text, record.tags, {
    volatility: verified ? 'durable' : 'state',
    ...(verified && item.type === 'decision' ? { canonical: true } : {}),
  });
}
