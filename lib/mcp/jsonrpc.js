// T-0137 — JSON-RPC 2.0 over newline-delimited stdio, written by hand because
// gatewright ships zero runtime dependencies and an MCP SDK would be the first
// one. The whole transport is this file: frame lines in, frame lines out.
//
// The framing rule MCP's stdio binding states is short and absolute: messages
// are UTF-8 JSON, delimited by newlines, and a message MUST NOT contain an
// embedded newline. JSON.stringify never emits a raw newline inside a string,
// so writing `JSON.stringify(message) + '\n'` satisfies the outbound half by
// construction; the inbound half is the reader below.

import { StringDecoder } from 'node:string_decoder';

// The standard codes, plus the two MCP leans on. Named rather than inlined
// because a wrong code is indistinguishable from a right one at a glance.
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

// A client that never sends a newline would otherwise grow the read buffer
// until the process dies of memory exhaustion, which on stdio is a hang with
// no diagnostic. Counted in decoded characters rather than bytes, because
// that is what is actually held in memory; for JSON-RPC, which is
// ASCII-dominant, the two are within a small factor either way. Eight million
// is far past any real tools/call on a board.
export const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

// Split an incoming byte stream into JSON text lines.
//
// StringDecoder rather than `String(chunk)`: a multi-byte character split
// across two stdin chunks decodes to replacement characters otherwise, which
// silently corrupts any non-ASCII title or note an agent sends.
export function createLineReader({ onMessage, onOverflow, limit = MAX_MESSAGE_CHARS } = {}) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  // Once a line has blown the limit its remainder is not a message and must
  // not be parsed as one: discard bytes until the newline that ends it.
  let discarding = false;

  // The limit is a property of the message, not of how the pipe happened to
  // chunk it: an over-long line is refused whether it arrived whole or in
  // pieces. Deciding from the buffer alone would make the same message
  // succeed or fail depending on the operating system's read sizes.
  function tooLong(line) {
    if (line.length <= limit) return false;
    onOverflow?.(limit);
    return true;
  }

  function drain() {
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (discarding) { discarding = false; continue; }
      if (tooLong(line)) continue;
      // Tolerate CRLF: a Windows client, or anything that went through a
      // line-ending filter, is not sending a malformed message.
      const text = line.endsWith('\r') ? line.slice(0, -1) : line;
      // Blank lines are whitespace between messages, not empty messages.
      if (text.trim() === '') continue;
      onMessage(text);
    }
    // Still no newline and already past the limit: stop holding the bytes,
    // and drop the rest of the line when it finally ends.
    if (buffer.length > limit) {
      buffer = '';
      discarding = true;
      onOverflow?.(limit);
    }
  }

  return {
    push(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drain();
    },
    // A final line with no trailing newline at end-of-stream is still a
    // message the client meant to send; dropping it would turn a client that
    // closes its pipe eagerly into an unexplained missing response.
    end() {
      buffer += decoder.end();
      const line = buffer;
      buffer = '';
      if (discarding) { discarding = false; return; }
      if (tooLong(line)) return;
      const text = line.trim();
      if (text !== '') onMessage(text);
    },
  };
}

export function serialize(message) {
  return `${JSON.stringify(message)}\n`;
}

export function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

export function failure(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

// Classify one decoded line. Returning a verdict rather than throwing keeps
// the dispatcher's shape flat: every line has exactly one of these outcomes,
// and the caller answers each without a try/catch around the protocol itself.
//
// `id` travels out of here even for invalid messages, because JSON-RPC wants
// the error correlated with the request whenever the id is recoverable.
export function classify(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    return { kind: 'parse-error', detail: error.message };
  }
  // JSON-RPC 2.0 has batches; MCP removed them in revision 2025-06-18, the
  // revision this server pins. Saying so beats "invalid request".
  if (Array.isArray(message)) {
    return { kind: 'invalid', id: null, detail: 'batched requests are not supported in protocol revision 2025-06-18; send one JSON-RPC message per line' };
  }
  if (message === null || typeof message !== 'object') {
    return { kind: 'invalid', id: null, detail: 'a JSON-RPC message must be an object' };
  }
  const hasId = Object.hasOwn(message, 'id');
  const id = hasId && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
  if (message.jsonrpc !== '2.0') {
    return { kind: 'invalid', id, detail: `unsupported jsonrpc version: ${JSON.stringify(message.jsonrpc ?? null)}; this server speaks "2.0"` };
  }
  // A response, not a request: this server issues no requests, so anything
  // with result/error is unsolicited. Ignore it rather than answering, since
  // answering a response is itself a protocol violation.
  if (!Object.hasOwn(message, 'method') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
    return { kind: 'ignore' };
  }
  if (typeof message.method !== 'string') {
    return { kind: 'invalid', id, detail: 'a JSON-RPC request must carry a string "method"' };
  }
  // MCP: the request id MUST NOT be null. An absent id is a notification,
  // which is a different thing and gets no response at all.
  if (hasId && id === null) {
    return { kind: 'invalid', id: null, detail: 'a request id must be a string or a number, and must not be null' };
  }
  const params = message.params ?? {};
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    return { kind: 'invalid', id, detail: '"params" must be an object' };
  }
  return { kind: hasId ? 'request' : 'notification', id, method: message.method, params };
}
