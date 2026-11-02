import DOMPurify from 'dompurify';
import { Lexer, Marked, type MarkedExtension, type Token, type Tokens } from 'marked';

import { CHAT_SANITIZE_CONFIG } from '../../utils/aiChatFormat';

/** The characters HTML gives meaning to, as text. */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Each line break is an element, so a text of nothing but line ends must not
 * draw one per line. Past this they read as spaces. */
const MAX_PLAIN_BREAKS = 20_000;

/**
 * Layout has two costs no limit on length sees, both from text that changes script
 * or direction all the time.
 *
 * Each change starts a new run, and a browser goes back over a block's runs for
 * each line it wraps, so a block draws in about the square of its changes: 250 KB
 * of `سa` takes 13 s as one block and a third of a second as blocks of 2 KB. A line
 * break does not help, because a block is laid out whole, so what counts is the
 * block. ASCII is one run, so every change takes a character past ASCII, and those
 * are what is counted. That leaves a long line of code at no cost, and these
 * limits are several pages of Chinese in one paragraph.
 *
 * WebKit also searches a word with no place to break again for each line, so the
 * same text with no spaces is far worse there: 16 KB of it took three minutes.
 * `withBreaks` gives such a word a place to break, which took that to 130 ms.
 */
const MAX_NON_ASCII_IN_BLOCK = 10_000;
/** While a text streams, because that is paid on every delta, and in plain text. */
const MAX_NON_ASCII_IN_SMALL_BLOCK = 2_000;
const MAX_UNBROKEN_CHARS = 256;

const SPACE = 32;
const LAST_ASCII = 126;

function nonAsciiIn(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > LAST_ASCII) count += 1;
  }
  return count;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * The text escaped, with a `<wbr>` in each word past the limit, or null if it has
 * none and can go out as usual. A `<wbr>` adds no character, so a word copies whole.
 */
function withBreaks(text: string): string | null {
  let html = '';
  let from = 0;
  let unbroken = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    unbroken = code <= SPACE ? 0 : unbroken + 1;
    if (unbroken >= MAX_UNBROKEN_CHARS && !isHighSurrogate(code)) {
      html += `${escapeHtml(text.slice(from, index + 1))}<wbr>`;
      from = index + 1;
      unbroken = 0;
    }
  }
  return from === 0 ? null : html + escapeHtml(text.slice(from));
}

const PLAIN_PIECE = /\r\n?|\n|[^\r\n]{1,2000}/gu;

/** The one safe answer when markdown or the sanitizer cannot be trusted: the
 * source as plain text, keeping its lines. */
function asPlainText(source: string): string {
  let breaks = 0;
  let nonAscii = 0;
  const blocks = source.replace(PLAIN_PIECE, (piece) => {
    if (piece[0] === '\r' || piece[0] === '\n') {
      breaks += 1;
      return breaks > MAX_PLAIN_BREAKS ? piece : '<br>';
    }
    const text = withBreaks(piece) ?? escapeHtml(piece);
    nonAscii += nonAsciiIn(piece);
    if (nonAscii < MAX_NON_ASCII_IN_SMALL_BLOCK) return text;
    nonAscii = 0;
    return `${text}</p><p>`;
  });
  return `<p>${blocks}</p>`;
}

/**
 * Tags from the Ask AI panel's list: no scripts, no handlers, no images, so
 * this text cannot load a remote address. Attributes are tighter than that
 * list, because this HTML lands inside a host's page: `class` would hand it the
 * host's own stylesheet (a full-page `fixed` link), and `data-*` or `aria-*`
 * would let it pose as the anchors hosts read off a text part.
 *
 * That list is the default. A host that passes `richMarkdown` opts in to images,
 * so to text that loads a remote address, plus what else `marked` writes for
 * GFM: `del`, a task's checkbox, a link's `title`, a list's `start`. `class`,
 * `style`, `data-*`, `aria-*` and handlers stay out of both.
 *
 * Read when the sanitizer is built, not on load, so this file and the one that
 * holds the list can import each other.
 */
function chatPurifyConfig(rich: boolean) {
  const tags = [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS, 'wbr'];
  const attributes = ['href', 'align'];
  return {
    ALLOWED_TAGS: rich ? [...tags, 'del', 'img', 'input'] : tags,
    ALLOWED_ATTR: rich
      ? [...attributes, 'title', 'start', ...RAW_IMAGE_ATTRIBUTES, 'type', 'checked', 'disabled']
      : attributes,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  };
}

/** Everything the sanitizer must take out. It proves itself on this before any
 * real text, because `isSupported` is not proof: a partial DOM reports true and
 * lets scripts through. */
const PROOF_INPUT =
  '<a href="javascript:alert(1)" class="c" data-c="1" onclick="alert(2)">kept</a>' +
  '<img src="x" onerror="alert(3)"><script>alert(4)</script>';
const PROOF_FAILED = /javascript:|class=|data-c|onclick|onerror|<img|<script/i;

/** The rich mode's proof: an image may stay, stripped, and nothing else changes.
 * It also has to take out a text field and disable a checkbox. */
const RICH_PROOF_INPUT = `${PROOF_INPUT}<img src="javascript:alert(5)" class="c" data-c="1"><input type="text"><input type="checkbox">`;
const RICH_PROOF_FAILED = /javascript:|class=|data-c|onclick|onerror|<script|type="text"|<input(?![^>]*\bdisabled)/i;

type Sanitize = (html: string) => string;

/**
 * How many images one text can ask for. `MAX_HTML_CHARS` bounds the DOM but not the
 * network: 255 KB of `<img>` is 15,000 requests, each with the host's cookies when
 * the address is its own. Past this an image is its alt text. Counted here because
 * every image passes here, from markdown and from a raw tag alike.
 */
const MAX_IMAGES_IN_TEXT = 100;

/** Firefox reads `loading` only if it comes before `src` (bug 1647077). */
function loadWhenNear(image: Element): void {
  const address = image.getAttribute('src');
  image.removeAttribute('src');
  image.setAttribute('loading', 'lazy');
  if (address !== null) image.setAttribute('src', address);
}

function buildSanitizer(rich: boolean): Sanitize | null {
  if (typeof window === 'undefined') return null;
  // A private instance: a hook on the shared one would reach every other caller.
  const purifier = DOMPurify(window);
  let images = 0;
  purifier.addHook('afterSanitizeAttributes', (node) => {
    // No form control a message can write: a checkbox only, and never a live one.
    if (node.nodeName === 'INPUT') {
      if (node.getAttribute('type')?.toLowerCase() === 'checkbox') node.setAttribute('disabled', '');
      else node.remove();
      return;
    }
    // `rich`, because this hook also sees what the default's allowlist took out.
    if (rich && node.nodeName === 'IMG') {
      images += 1;
      if (images > MAX_IMAGES_IN_TEXT) node.replaceWith(node.getAttribute('alt') ?? '');
      else loadWhenNear(node);
      return;
    }
    // Links open in a new tab: a host must not lose its page to a link in a
    // message. Set after the allowlist has run, so only this code writes them.
    if (node.nodeName !== 'A') return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  const config = chatPurifyConfig(rich);
  const sanitize: Sanitize = (html) => {
    images = 0;
    return purifier.sanitize(html, config);
  };
  const proof = sanitize(rich ? RICH_PROOF_INPUT : PROOF_INPUT);
  if ((rich ? RICH_PROOF_FAILED : PROOF_FAILED).test(proof) || !proof.includes('kept')) return null;
  return sanitize;
}

/** One proof per mode: passing one says nothing about the other's allowlist. */
const provenSanitizers = new Map<boolean, Sanitize | null>();

/** The sanitizer, once it has shown it works here. Null: nothing may go out as HTML. */
function sanitizerThatWorks(rich: boolean): Sanitize | null {
  let sanitizer = provenSanitizers.get(rich);
  if (sanitizer === undefined) {
    try {
      sanitizer = buildSanitizer(rich);
    } catch {
      sanitizer = null;
    }
    provenSanitizers.set(rich, sanitizer);
  }
  return sanitizer;
}

/**
 * `marked` has inputs that overflow the stack, inputs that take minutes and
 * inputs that build a page's worth of nodes, and running out of memory kills
 * the tab with nothing to catch. So the work is bounded at each step it can
 * grow, and a text past a limit draws as plain text:
 *
 * - Before `marked`: the text's length.
 * - Inside `marked`: a time budget, checked at each token, each run of inline
 *   text and each link drawn. It is a check, not a wall: one tokenizer call can
 *   overrun it, so `chatTextRenderer` stops a stream paying for that again.
 * - After `marked`: the length of the HTML, lower while a text streams. Raw HTML
 *   goes out escaped on both of `marked`'s ways out, the `html` and `text`
 *   renderers, so what is left is `marked`'s own well-formed output and its length
 *   is its size in the DOM. That is what bounds sanitizing and drawing: a short
 *   string of unclosed tags can parse into a million nodes.
 * - For layout: the characters past ASCII in each block, as `checkBlock` counts
 *   them. A text past that draws as plain text in smaller blocks.
 *
 * Two limits are local. A table past the cell limit is left as the text it is,
 * and a run of inline text that `tooMuchInline` refuses draws as literal text,
 * because those costs sit where no budget check reaches. The rest of the message
 * stays formatted, and both are asked where `marked` itself would do the work, so
 * a code block never counts.
 *
 * The budget is wall-clock, so a text close to it can draw either way.
 */
const MARKDOWN_BUDGET_MS = 250;
const MAX_TEXT_CHARS = 256_000;
const MAX_TABLE_CELLS = 100_000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_STREAMED_HTML_CHARS = 250_000;
const MAX_WORD_CHARS = 8_000;
const MAX_SPACE_RUN = 1_000;
/** About a tenth of a second of copying on a laptop. */
const MAX_MASKING_WORK = 1_000_000_000;

/** What opens a masked run: `<`, `[`, a backslash and a backtick. */
const MASKED_MARKS = new Set([60, 91, 92, 96]);

const TABLE_DELIMITER = /^[ :|-]+$/;

/**
 * Would a table starting here pad past the cell limit? Every row is padded to
 * the header's width inside one tokenizer call, which no check inside `marked`
 * can interrupt and which can run the tab out of memory. A table's width is its
 * delimiter row, the second line, and its rows end by the next blank line at the
 * latest.
 */
function tableTooBig(src: string): boolean {
  const delimiterAt = src.indexOf('\n') + 1;
  if (delimiterAt === 0) return false;
  const lineEnd = src.indexOf('\n', delimiterAt);
  const delimiter = src.slice(delimiterAt, lineEnd === -1 ? src.length : lineEnd);
  if (!TABLE_DELIMITER.test(delimiter)) return false;
  const columns = delimiter.split('|').length;
  let rows = 0;
  let at = lineEnd;
  while (at !== -1 && src[at + 1] !== '\n' && columns * rows <= MAX_TABLE_CELLS) {
    rows += 1;
    at = src.indexOf('\n', at + 1);
  }
  return columns * rows > MAX_TABLE_CELLS;
}

/**
 * Is this run of inline text past what `marked` can do between budget checks?
 *
 * A word: only ASCII adds to one, because `marked`'s inline expressions stop at
 * anything else, so a paragraph of Chinese with no spaces is not one long word.
 * Other letters do not end a word either, or they could split a hostile run.
 *
 * A run of spaces: with `breaks: true` that is quadratic inside one expression.
 *
 * Masking: before its first token `marked` copies the whole run once for each
 * code span, tag, link or escape in it, so marks times length is what it costs.
 */
function tooMuchInline(text: string): boolean {
  let word = 0;
  let spaces = 0;
  let marks = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    spaces = code === SPACE ? spaces + 1 : 0;
    if (spaces > MAX_SPACE_RUN) return true;
    if (code <= SPACE) {
      word = 0;
    } else if (code <= LAST_ASCII) {
      word += 1;
      if (word > MAX_WORD_CHARS) return true;
      if (MASKED_MARKS.has(code)) marks += 1;
    }
  }
  return marks * text.length > MAX_MASKING_WORK;
}

let deadline = 0;
let blockLimit = MAX_NON_ASCII_IN_BLOCK;

/** A tokenizer that matches nothing: `marked` asks it before every token. */
function checkBudget(): undefined {
  if (Date.now() > deadline) throw new Error('markdown budget spent');
  return undefined;
}

/** Called with all the text of one block: a run of inline text, a code block or a
 * block of raw HTML. Past the limit the whole message draws as plain text. */
function checkBlock(text: string): void {
  if (nonAsciiIn(text) > blockLimit) throw new Error('block too costly to lay out');
}

const budgetExtension: MarkedExtension = {
  extensions: [
    { name: 'chatBudgetBlock', level: 'block', tokenizer: checkBudget },
    { name: 'chatBudgetInline', level: 'inline', tokenizer: checkBudget },
  ],
  tokenizer: {
    // `marked` asks this only where a table can start, never inside a code
    // block. Undefined: not a table. False: go on and try one.
    table(src) {
      return tableTooBig(src) ? undefined : false;
    },
  },
  // A reference link repeats its whole address at every use, and that is drawn
  // after the tokens are done. False: draw it the usual way.
  renderer: {
    // After a raw `<code>`, `<kbd>`, `<pre>` or `<script>`, `marked` flags the text
    // that follows as already escaped, up to the closing tag, and writes it out as
    // it stands. Nothing here is escaped yet: escaping is this renderer's job.
    text(token) {
      if ('escaped' in token) token.escaped = false;
      if ('tokens' in token && token.tokens) return false;
      return withBreaks(token.text) ?? false;
    },
    codespan({ text }) {
      const html = withBreaks(text);
      return html === null ? false : `<code>${html}</code>`;
    },
    code({ text }) {
      checkBlock(text);
      return false;
    },
    link() {
      checkBudget();
      return false;
    },
    image() {
      checkBudget();
      return false;
    },
  },
};

/** Sees every run of inline text, nested ones too, before `marked`'s own passes
 * over it. A code block is never one, so these limits do not reach it. */
class BoundedLexer extends Lexer {
  override inlineTokens(src: string, tokens: Token[] = []): Token[] {
    checkBudget();
    checkBlock(src);
    if (tooMuchInline(src)) {
      tokens.push({ type: 'text', raw: src, text: src });
      return tokens;
    }
    return super.inlineTokens(src, tokens);
  }
}

const LINE_BREAK_TAG = /^<br\s*\/?>\s*$/i;

/** Raw HTML as the text it is. A block of it keeps its own `<p>`, or blocks in a
 * row would run together into one for layout. */
function rawHtmlAsText(token: Tokens.HTML | Tokens.Tag): string {
  checkBlock(token.text);
  const text = withBreaks(token.text) ?? escapeHtml(token.text);
  return 'block' in token && token.block ? `<p>${text}</p>` : text;
}

/** CommonMark's open tag, which is what `marked` calls a tag. A tag spelled any
 * other way is text to `marked`, so it never gets here. */
const RAW_DRAWN_TAG = /<(img|input)((?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gi;
const RAW_ATTRIBUTE = /([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

/** All an image in a message can say, in the order it is written. */
const RAW_IMAGE_ATTRIBUTES = ['src', 'alt', 'title', 'width', 'height'];

/** The first spelling of each attribute wins, as in an HTML parser. */
function rawAttributes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, double, single, bare] of text.matchAll(RAW_ATTRIBUTE)) {
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, double ?? single ?? bare ?? '');
  }
  return found;
}

/** A value for double quotes. `&` stays: it is the author's own entity, and the
 * sanitizer reads the value once the parser has decoded it. */
function asAttributeValue(value: string): string {
  return value.replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function freshTag(tag: string, attributeText: string): string {
  const attributes = rawAttributes(attributeText);
  if (tag.toLowerCase() === 'input') {
    if (attributes.get('type')?.toLowerCase() !== 'checkbox') return '';
    return `<input type="checkbox" disabled${attributes.has('checked') ? ' checked' : ''}>`;
  }
  const kept = RAW_IMAGE_ATTRIBUTES.filter((name) => attributes.has(name)).map(
    (name) => ` ${name}="${asAttributeValue(attributes.get(name)!)}"`,
  );
  return `<img${kept.join('')}>`;
}

function isComment(text: string): boolean {
  const comment = text.trim();
  return comment.startsWith('<!--') && comment.indexOf('-->') === comment.length - 3;
}

/**
 * The rich mode's raw HTML. An image and a checkbox draw, each written fresh from
 * the attributes it may have, so nothing of the source reaches the parser and a
 * browser's reading of the tag cannot differ from this one. `marked`'s pattern
 * accepted the tag first. Any other `<input>` goes, and a comment draws nothing.
 * The rest stays the text it is, which is what keeps `MAX_HTML_CHARS` a limit on
 * the nodes: void tags are one node each, and an unclosed `<b>` never gets here.
 * A block that is only images and checkboxes gets no `<p>`, so it takes no
 * paragraph's margin.
 */
function rawHtmlWithMedia(token: Tokens.HTML | Tokens.Tag): string {
  checkBlock(token.text);
  if (isComment(token.text)) return '';
  const asText = (text: string): string => withBreaks(text) ?? escapeHtml(text);
  let html = '';
  let from = 0;
  for (const match of token.text.matchAll(RAW_DRAWN_TAG)) {
    html += asText(token.text.slice(from, match.index)) + freshTag(match[1], match[2]);
    from = match.index + match[0].length;
  }
  html += asText(token.text.slice(from));
  const hasWords = token.text.replace(RAW_DRAWN_TAG, '').trim() !== '';
  return 'block' in token && token.block && hasWords ? `<p>${html}</p>` : html;
}

/**
 * Raw HTML never reaches an HTML parser here: it goes out escaped, by this
 * renderer and by the `text` one in `budgetExtension`. A browser rebuilds every
 * open formatting tag in each new paragraph, so 27 KB of unclosed tags makes a
 * million nodes inside the sanitizer, where no limit reaches. An answer is
 * markdown. The one tag kept is a line break, because agents write it in table
 * cells; it is written fresh here, so nothing of the source gets through.
 */
const agentMarkdown = new Marked(
  {
    gfm: true,
    breaks: false,
    renderer: {
      html(token) {
        return LINE_BREAK_TAG.test(token.text) ? '<br>' : rawHtmlAsText(token);
      },
    },
  },
  budgetExtension,
);

/** `agentMarkdown` for a host that passes `richMarkdown`. */
const richAgentMarkdown = new Marked(
  {
    gfm: true,
    breaks: false,
    renderer: {
      html(token) {
        return LINE_BREAK_TAG.test(token.text) ? '<br>' : rawHtmlWithMedia(token);
      },
    },
  },
  budgetExtension,
);

/** A person's HTML, every tag of it, stays the literal text they typed, in both
 * modes. Markdown image syntax is what the rich mode's sanitizer lets them draw. */
const personMarkdown = new Marked(
  {
    gfm: true,
    breaks: false,
    renderer: {
      html(token) {
        return rawHtmlAsText(token);
      },
    },
  },
  budgetExtension,
);

function parseMarkdown(markdown: Marked, source: string, streaming = false): string {
  deadline = Date.now() + MARKDOWN_BUDGET_MS;
  blockLimit = streaming ? MAX_NON_ASCII_IN_SMALL_BLOCK : MAX_NON_ASCII_IN_BLOCK;
  return markdown.parser(new BoundedLexer(markdown.defaults).lex(source));
}

interface RenderedMessage {
  readonly html: string;
  /** Too costly to draw again on every delta of a stream. */
  readonly spent: boolean;
}

/** The one way out to the DOM. It never throws: a render that throws would take
 * the host's whole React root with it. */
function renderMessage(
  markdown: Marked,
  source: string,
  streaming: boolean,
  rich = false,
): RenderedMessage {
  const sanitize = sanitizerThatWorks(rich);
  if (sanitize === null || source.length > MAX_TEXT_CHARS) {
    return { html: asPlainText(source), spent: true };
  }
  try {
    const html = parseMarkdown(markdown, source, streaming);
    const limit = streaming ? MAX_STREAMED_HTML_CHARS : MAX_HTML_CHARS;
    if (html.length > limit) return { html: asPlainText(source), spent: true };
    const clean = sanitize(html);
    return { html: clean, spent: Date.now() > deadline };
  } catch {
    return { html: asPlainText(source), spent: true };
  }
}

function markdownFor(literalHtml: boolean, rich: boolean): Marked {
  if (literalHtml) return personMarkdown;
  return rich ? richAgentMarkdown : agentMarkdown;
}

/** An agent's text as sanitized HTML. */
export function chatMarkdownHtml(markdown: string): string {
  return renderMessage(agentMarkdown, markdown, false).html;
}

/** {@link chatMarkdownHtml} or, with `literalHtml`, {@link personMarkdownHtml}, in
 * the mode `richMarkdown` turns on. Images load remote addresses from this text. */
export function richMarkdownHtml(markdown: string, { literalHtml = false } = {}): string {
  return renderMessage(markdownFor(literalHtml, true), markdown, false, true).html;
}

/** A held text redraws once it has grown by an eighth. */
const HELD_TEXT_GROWTH = 1.125;

/**
 * The render for one text as it streams. Every delta re-renders the whole text,
 * so a text too costly for that is held: plain, and redrawn only as it grows by a
 * fixed share, so what a stream pays per delta stops growing with its length. A
 * text is held once it spends its budget or passes a streaming limit, on its HTML
 * or on a block. Call with `streaming` false when the stream ends: that always renders in full,
 * so an honest message held for a moment comes back whole and formatted.
 */
export function chatTextRenderer(
  literalHtml: boolean,
  rich = false,
): (text: string, streaming: boolean) => string {
  const markdown = markdownFor(literalHtml, rich);
  let held: { readonly text: string; readonly html: string } | null = null;
  return (text, streaming) => {
    if (streaming && held !== null && text.startsWith(held.text)) {
      if (text.length < held.text.length * HELD_TEXT_GROWTH) return held.html;
      held = { text, html: asPlainText(text) };
      return held.html;
    }
    const { html, spent } = renderMessage(markdown, text, streaming, rich);
    held = streaming && spent ? { text, html } : null;
    return html;
  };
}

/** The markdown step of {@link personMarkdownHtml}, before sanitizing. */
export function personMarkdownToHtml(markdown: string): string {
  return parseMarkdown(personMarkdown, markdown);
}

/** A person's message: markdown, but HTML they typed stays the literal text
 * they typed. The sanitizer still runs after, as for every message. */
export function personMarkdownHtml(markdown: string): string {
  return renderMessage(personMarkdown, markdown, false).html;
}
