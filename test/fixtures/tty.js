import { PassThrough } from 'node:stream';

// A terminal is simulated rather than borrowed: `node --test` gives the suite
// no TTY, so a test that depended on a real one would skip in exactly the
// place this behaviour matters most.
//
// Answers are fed one at a time in response to a prompt, never written up
// front. readline emits a 'line' event for every buffered line the moment it
// attaches, and question() consumes only the first -- so a pre-filled buffer
// loses every answer after the first and the wizard stalls forever waiting for
// input that was already thrown away.
export function fakeTty(scripted = []) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  output.isTTY = true;
  let text = '';
  const queue = [...scripted];
  output.on('data', (chunk) => {
    text += chunk;
    if (/: $/.test(String(chunk)) && queue.length) {
      const next = queue.shift();
      setImmediate(() => input.write(`${next}\n`));
    }
  });
  return { input, output, read: () => text, remaining: () => queue.length };
}
