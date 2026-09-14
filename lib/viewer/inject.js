// Data blocks -> pinned shell -> .gatewright/board.html. A file:// document is
// an opaque origin, so the viewer never fetches its own data: gw open inlines
// it instead. Escaping here is what keeps an item title from breaking out of
// its <script type="application/json"> block.
const BLOCK_IDS = ['gw-items', 'gw-events', 'gw-stages', 'gw-config'];

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

// JSON.parse only ever sees the escape sequence, never the HTML parser: a
// title of `</script>` or `<!--` can't close the block or open a comment, and
// U+2028/U+2029 can't be misread as line terminators by a strict JS parser.
function escapeForScript(json) {
  return json
    .split('<').join('\\u003c')
    .split(LINE_SEPARATOR).join('\\u2028')
    .split(PARAGRAPH_SEPARATOR).join('\\u2029');
}

function renderBlock(id, value) {
  return `<script type="application/json" id="${id}">${escapeForScript(JSON.stringify(value))}</script>`;
}

export function injectData(shellHtml, { items, events, stages, config, generatedAt }) {
  const blocks = [
    renderBlock('gw-items', items),
    renderBlock('gw-events', events),
    renderBlock('gw-stages', stages),
    renderBlock('gw-config', { ...config, generatedAt }),
  ].join('\n');

  let out = shellHtml;
  for (const id of BLOCK_IDS) {
    const re = new RegExp(`\\s*<script type="application/json" id="${id}">[\\s\\S]*?<\\/script>`);
    out = out.replace(re, '');
  }

  return out.replace(/<\/body>/, `${blocks}\n</body>`);
}
