// Second Brain is optional. Keep this adapter to the platform fetch API so the
// default Gatewright install remains dependency-free.

function providerConfig(config) {
  return config.providers?.['second-brain'] ?? config;
}

function malformed(tool) {
  return new Error(`Second Brain ${tool} response was malformed.`);
}

function responseBody(response) {
  const result = response?.result;
  if (!result || typeof result !== 'object') throw malformed('MCP');
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object') return structured;
  if (Array.isArray(result.content)) {
    const text = result.content.find((part) => part?.type === 'text' && typeof part.text === 'string')?.text;
    if (text === undefined) throw malformed('MCP');
    try { return JSON.parse(text); } catch { return text; }
  }
  return result;
}

function recallHits(body) {
  const hits = Array.isArray(body) ? body : body?.results ?? body?.hits ?? body?.memories;
  if (!Array.isArray(hits)) throw malformed('recall');
  return hits.flatMap((hit) => {
    if (!hit || typeof hit !== 'object') return [];
    const text = hit.text ?? hit.content;
    if (typeof text !== 'string') return [];
    return [{
      text,
      tags: Array.isArray(hit.tags) ? hit.tags.filter((tag) => typeof tag === 'string') : [],
      date: typeof hit.date === 'string' ? hit.date : (typeof hit.created_at === 'string' ? hit.created_at : ''),
    }];
  });
}

function capsulePrefix(body) {
  if (typeof body === 'string') return body;
  const prefix = body?.prefix ?? body?.capsule;
  if (typeof prefix !== 'string') throw malformed('get_prompt_capsule');
  return prefix;
}

async function fetchTransport(url, request, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function createProvider({ config = {}, transport = fetchTransport, env = process.env } = {}) {
  const settings = providerConfig(config);
  const url = settings.url;
  const tokenEnv = settings.token_env;

  async function callTool(name, args) {
    if (!tokenEnv || typeof tokenEnv !== 'string') throw new Error('Second Brain token_env is required.');
    const token = env[tokenEnv];
    if (!token) throw new Error(`Second Brain token environment variable "${tokenEnv}" is not set.`);
    if (!url || typeof url !== 'string') throw new Error('Second Brain url is required.');
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
    try {
      return await transport(url, request, token);
    } catch {
      // Do not pass through a transport error: fetch implementations and test
      // doubles are free to include request headers in their diagnostics.
      throw new Error(`Second Brain ${name} request failed.`);
    }
  }

  return {
    async recall(query, n) {
      const response = await callTool('recall', { query, topK: n });
      return recallHits(responseBody(response));
    },
    async remember(text, tags, { volatility, canonical } = {}) {
      const response = await callTool('remember', {
        content: text,
        tags,
        source: 'gatewright',
        ...(volatility === undefined ? {} : { volatility }),
        ...(canonical === undefined ? {} : { canonical }),
      });
      const body = responseBody(response);
      return typeof body?.id === 'string' ? body.id : null;
    },
    async capsule(projectId) {
      const response = await callTool('get_prompt_capsule', { project_id: projectId, kind: 'project' });
      return capsulePrefix(responseBody(response));
    },
  };
}
