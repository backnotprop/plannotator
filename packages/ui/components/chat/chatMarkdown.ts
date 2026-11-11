import DOMPurify from 'dompurify';
import { Lexer, Marked, type MarkedExtension, type Token, type Tokens } from 'marked';

import { CHAT_SANITIZE_CONFIG } from '../../utils/aiChatFormat';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Each line break is an element, so a text of nothing but line ends must not draw one per line. */
const MAX_PLAIN_BREAKS = 20_000;

/**
 * WebKit also searches a word with no place to break again for each line, so the same text with
 * no spaces is far worse there: 16 KB of it took three minutes.
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

/** A `<wbr>` adds no character, so a word copies whole. */
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

/**
 * The one safe answer when markdown or the sanitizer cannot be trusted: the source as plain
 * text, keeping its lines.
 */
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
 * Attributes are tighter than that list, because this HTML lands inside a host's page: `class`
 * would hand it the host's own stylesheet (a full-page `fixed` link), and `data-*` or `aria-*`
 * would let it pose as the anchors hosts read off a text part.
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

/** Everything the sanitizer must take out. */
const PROOF_INPUT =
  '<a href="javascript:alert(1)" class="c" data-c="1" onclick="alert(2)">kept</a>' +
  '<img src="x" onerror="alert(3)"><script>alert(4)</script>';
const PROOF_FAILED = /javascript:|class=|data-c|onclick|onerror|<img|<script/i;

const RICH_PROOF_INPUT = `${PROOF_INPUT}<img src="javascript:alert(5)" class="c" data-c="1"><input type="text"><input type="checkbox">`;
const RICH_PROOF_FAILED = /javascript:|class=|data-c|onclick|onerror|<script|type="text"|<input(?![^>]*\bdisabled)/i;

type Sanitize = (html: string) => string;

/** Counted here because every image passes here, from markdown and from a raw tag alike. */
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
    // Links open in a new tab: a host must not lose its page to a link in a message.
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

const MARKDOWN_BUDGET_MS = 250;
const MAX_TEXT_CHARS = 256_000;
const MAX_TABLE_CELLS = 100_000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_STREAMED_HTML_CHARS = 250_000;
const MAX_WORD_CHARS = 8_000;
const MAX_SPACE_RUN = 1_000;
const MAX_MASKING_WORK = 1_000_000_000;

const MASKED_MARKS = new Set([60, 91, 92, 96]);

const TABLE_DELIMITER = /^[ :|-]+$/;

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
 * A word: only ASCII adds to one, because `marked`'s inline expressions stop at anything else,
 * so a paragraph of Chinese with no spaces is not one long word.
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

function checkBudget(): undefined {
  if (Date.now() > deadline) throw new Error('markdown budget spent');
  return undefined;
}

function checkBlock(text: string): void {
  if (nonAsciiIn(text) > blockLimit) throw new Error('block too costly to lay out');
}

const budgetExtension: MarkedExtension = {
  extensions: [
    { name: 'chatBudgetBlock', level: 'block', tokenizer: checkBudget },
    { name: 'chatBudgetInline', level: 'inline', tokenizer: checkBudget },
  ],
  tokenizer: {
    // `marked` asks this only where a table can start, never inside a code block.
    table(src) {
      return tableTooBig(src) ? undefined : false;
    },
  },
  renderer: {
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

/** A code block is never one, so these limits do not reach it. */
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

function rawHtmlAsText(token: Tokens.HTML | Tokens.Tag): string {
  checkBlock(token.text);
  const text = withBreaks(token.text) ?? escapeHtml(token.text);
  return 'block' in token && token.block ? `<p>${text}</p>` : text;
}

/** A tag spelled any other way is text to `marked`, so it never gets here. */
const RAW_DRAWN_TAG = /<(img|input)((?:\s+[a-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/gi;
const RAW_ATTRIBUTE = /([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;

const RAW_IMAGE_ATTRIBUTES = ['src', 'alt', 'title', 'width', 'height'];

function rawAttributes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [, name, double, single, bare] of text.matchAll(RAW_ATTRIBUTE)) {
    const key = name.toLowerCase();
    if (!found.has(key)) found.set(key, double ?? single ?? bare ?? '');
  }
  return found;
}

/**
 * `&` stays: it is the author's own entity, and the sanitizer reads the value once the parser
 * has decoded it.
 */
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
 * A browser rebuilds every open formatting tag in each new paragraph, so 27 KB of unclosed tags
 * makes a million nodes inside the sanitizer, where no limit reaches.
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

/** Markdown image syntax is what the rich mode's sanitizer lets them draw. */
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

const MAX_KEPT_BLANK_LINES = 10;

let keptBlankLines = new WeakMap<Token, number>();

function blankLinesBefore(tokens: readonly Token[], index: number): number {
  let before = '';
  let reachedText = false;
  for (let at = index - 1; at >= 0 && !reachedText; at -= 1) {
    before = tokens[at].raw + before;
    reachedText = tokens[at].type !== 'space';
  }
  if (!reachedText) return 0;
  const lines = before.split('\n');
  lines.pop();
  let blank = 0;
  for (let at = lines.length - 1; at >= 0 && lines[at].trim() === '' && blank < MAX_KEPT_BLANK_LINES; at -= 1) {
    blank += 1;
  }
  return blank >= 2 ? blank : 0;
}

/**
 * The run is drawn as one `<br>` per blank line past the first before the paragraph, the first
 * being the paragraph gap itself: no `style` or `class` reaches the sanitizer.
 */
const typedPersonMarkdown = new Marked(
  {
    gfm: true,
    breaks: true,
    renderer: {
      html(token) {
        return rawHtmlAsText(token);
      },
      paragraph(token) {
        const blank = keptBlankLines.get(token);
        if (blank === undefined) return false;
        return `${'<br>'.repeat(blank - 1)}<p>${this.parser.parseInline(token.tokens)}</p>\n`;
      },
    },
  },
  budgetExtension,
);

function parseMarkdown(markdown: Marked, source: string, streaming = false): string {
  deadline = Date.now() + MARKDOWN_BUDGET_MS;
  blockLimit = streaming ? MAX_NON_ASCII_IN_SMALL_BLOCK : MAX_NON_ASCII_IN_BLOCK;
  const tokens = new BoundedLexer(markdown.defaults).lex(source);
  if (markdown === typedPersonMarkdown) {
    keptBlankLines = new WeakMap();
    tokens.forEach((token, index) => {
      if (token.type !== 'paragraph') return;
      const blank = blankLinesBefore(tokens, index);
      if (blank > 0) keptBlankLines.set(token, blank);
    });
  }
  return markdown.parser(tokens);
}

interface RenderedMessage {
  readonly html: string;
  readonly spent: boolean;
}

/**
 * The one way out to the DOM. It never throws: a render that throws would take the host's whole
 * React root with it.
 */
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

function markdownFor(literalHtml: boolean, rich: boolean, keepBlankLines = false): Marked {
  if (literalHtml) return keepBlankLines ? typedPersonMarkdown : personMarkdown;
  return rich ? richAgentMarkdown : agentMarkdown;
}

/** An agent's text as sanitized HTML. */
export function chatMarkdownHtml(markdown: string): string {
  return renderMessage(agentMarkdown, markdown, false).html;
}

/**
 * {@link chatMarkdownHtml} or, with `literalHtml`, {@link personMarkdownHtml}, in the mode
 * `richMarkdown` turns on.
 */
export function richMarkdownHtml(markdown: string, { literalHtml = false } = {}): string {
  return renderMessage(markdownFor(literalHtml, true), markdown, false, true).html;
}

const HELD_TEXT_GROWTH = 1.125;

/** The render for one text as it streams. */
export function chatTextRenderer(
  literalHtml: boolean,
  rich = false,
  keepBlankLines = false,
): (text: string, streaming: boolean) => string {
  const markdown = markdownFor(literalHtml, rich, keepBlankLines);
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

/**
 * A person's message: markdown, but HTML they typed stays the literal text they typed. The
 * sanitizer still runs after, as for every message.
 */
export function personMarkdownHtml(markdown: string): string {
  return renderMessage(personMarkdown, markdown, false).html;
}
