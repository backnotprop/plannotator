import DOMPurify from 'dompurify';
import { Lexer, Marked, type MarkedExtension, type Token } from 'marked';

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

/** The one safe answer when markdown or the sanitizer cannot be trusted: the
 * source as plain text, keeping its lines. */
function asPlainText(source: string): string {
  let breaks = 0;
  const lines = escapeHtml(source).replace(/\n/g, (end) => {
    breaks += 1;
    return breaks > MAX_PLAIN_BREAKS ? end : '<br>';
  });
  return `<p>${lines}</p>`;
}

/**
 * Tags from the Ask AI panel's list: no scripts, no handlers, no images, so
 * this text cannot load a remote address. Attributes are tighter than that
 * list, because this HTML lands inside a host's page: `class` would hand it the
 * host's own stylesheet (a full-page `fixed` link), and `data-*` or `aria-*`
 * would let it pose as the anchors hosts read off a text part.
 *
 * Read when the sanitizer is built, not on load, so this file and the one that
 * holds the list can import each other.
 */
function chatPurifyConfig() {
  return {
    ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
    ALLOWED_ATTR: ['href', 'align'],
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

type Sanitize = (html: string) => string;

function buildSanitizer(): Sanitize | null {
  if (typeof window === 'undefined') return null;
  // A private instance: a hook on the shared one would reach every other caller.
  const purifier = DOMPurify(window);
  // Links open in a new tab: a host must not lose its page to a link in a
  // message. Set after the allowlist has run, so only this code writes them.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName !== 'A') return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  const config = chatPurifyConfig();
  const proof = purifier.sanitize(PROOF_INPUT, config);
  if (PROOF_FAILED.test(proof) || !proof.includes('kept')) return null;
  return (html) => purifier.sanitize(html, config);
}

let provenSanitizer: Sanitize | null | undefined;

/** The sanitizer, once it has shown it works here. Null: nothing may go out as HTML. */
function sanitizerThatWorks(): Sanitize | null {
  if (provenSanitizer === undefined) {
    try {
      provenSanitizer = buildSanitizer();
    } catch {
      provenSanitizer = null;
    }
  }
  return provenSanitizer;
}

/**
 * `marked` has inputs that overflow the stack, inputs that take minutes and
 * inputs that build a page's worth of nodes, and running out of memory kills
 * the tab with nothing to catch. So the work is bounded at each step it can
 * grow, and a text past a limit draws as plain text:
 *
 * - Before `marked`: the text's length, and the cells a table in it could
 *   reach. Every row is padded to the header's width inside one tokenizer call,
 *   which no check inside `marked` can interrupt.
 * - Inside `marked`: a time budget, checked at each token, each run of inline
 *   text and each link drawn. It is a check, not a wall: one tokenizer call can
 *   overrun it, so `chatTextRenderer` stops a stream paying for that again.
 * - After `marked`: the length of the HTML, which bounds sanitizing and drawing.
 *
 * One limit is local. A run of inline text that `tooMuchInline` refuses is not
 * parsed, because that cost sits where no budget check reaches: it draws as
 * literal text and the rest of the message stays formatted. Code blocks are
 * never inline text, so a long line in one costs nothing.
 *
 * The budget is wall-clock, so a text close to it can draw either way.
 */
const MARKDOWN_BUDGET_MS = 250;
const MAX_TEXT_CHARS = 256_000;
const MAX_TABLE_CELLS = 100_000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_WORD_CHARS = 8_000;
/** About a tenth of a second of copying on a laptop. */
const MAX_MASKING_WORK = 1_000_000_000;

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const PIPE = 124;
const LAST_ASCII = 126;
/** What opens a masked run: `<`, `[`, a backslash and a backtick. */
const MASKED_MARKS = new Set([60, 91, 92, 96]);

/** Refused before `marked` sees it. Pipes on the widest line times the lines is
 * the most cells a table could pad to. A lone `\r` ends a line for `marked` too. */
function tooMuchToParse(source: string): boolean {
  if (source.length > MAX_TEXT_CHARS) return true;
  let lines = 1;
  let pipes = 0;
  let widest = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === PIPE) {
      pipes += 1;
      if (pipes > widest) widest = pipes;
    } else if (
      code === LINE_FEED ||
      (code === CARRIAGE_RETURN && source.charCodeAt(index + 1) !== LINE_FEED)
    ) {
      lines += 1;
      pipes = 0;
    }
  }
  return widest * lines > MAX_TABLE_CELLS;
}

/**
 * Is this run of inline text past what `marked` can do between budget checks?
 *
 * A word: only ASCII adds to one, because `marked`'s inline expressions stop at
 * anything else, so a paragraph of Chinese with no spaces is not one long word.
 * Other letters do not end a word either, or they could split a hostile run.
 *
 * Masking: before its first token `marked` copies the whole run once for each
 * code span, tag, link or escape in it, so marks times length is what it costs.
 */
function tooMuchInline(text: string): boolean {
  let word = 0;
  let marks = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
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

/** A tokenizer that matches nothing: `marked` asks it before every token. */
function checkBudget(): undefined {
  if (Date.now() > deadline) throw new Error('markdown budget spent');
  return undefined;
}

const budgetExtension: MarkedExtension = {
  extensions: [
    { name: 'chatBudgetBlock', level: 'block', tokenizer: checkBudget },
    { name: 'chatBudgetInline', level: 'inline', tokenizer: checkBudget },
  ],
  // A reference link repeats its whole address at every use, and that is drawn
  // after the tokens are done. False: draw it the usual way.
  renderer: {
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
 * over it. This is why a code block costs nothing here: it is never one. */
class BoundedLexer extends Lexer {
  override inlineTokens(src: string, tokens: Token[] = []): Token[] {
    checkBudget();
    if (tooMuchInline(src)) {
      tokens.push({ type: 'text', raw: src, text: src });
      return tokens;
    }
    return super.inlineTokens(src, tokens);
  }
}

const agentMarkdown = new Marked({ gfm: true, breaks: false }, budgetExtension);

/** `marked` hands every raw HTML token to the `html` renderer; this one writes
 * it back as escaped text. */
const personMarkdown = new Marked(
  {
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
    },
  },
  budgetExtension,
);

function parseMarkdown(markdown: Marked, source: string): string {
  deadline = Date.now() + MARKDOWN_BUDGET_MS;
  return markdown.parser(new BoundedLexer(markdown.defaults).lex(source));
}

interface RenderedMessage {
  readonly html: string;
  /** This text cost its whole budget, so drawing it again would too. */
  readonly spent: boolean;
}

/** The one way out to the DOM. It never throws: a render that throws would take
 * the host's whole React root with it. */
function renderMessage(markdown: Marked, source: string): RenderedMessage {
  const sanitize = sanitizerThatWorks();
  if (sanitize === null || tooMuchToParse(source)) {
    return { html: asPlainText(source), spent: false };
  }
  try {
    const html = parseMarkdown(markdown, source);
    if (html.length > MAX_HTML_CHARS) return { html: asPlainText(source), spent: true };
    const clean = sanitize(html);
    return { html: clean, spent: Date.now() > deadline };
  } catch {
    return { html: asPlainText(source), spent: true };
  }
}

/** An agent's text as sanitized HTML. */
export function chatMarkdownHtml(markdown: string): string {
  return renderMessage(agentMarkdown, markdown).html;
}

/**
 * The render for one text as it streams. Every delta re-renders the whole text,
 * so once a text has spent its budget it stays plain while it keeps growing, and
 * a hostile stream pays once instead of on every delta. Call with `streaming`
 * false when the stream ends: that always renders in full, so an honest message
 * that lost a delta to a busy page comes back formatted.
 */
export function chatTextRenderer(literalHtml: boolean): (text: string, streaming: boolean) => string {
  const markdown = literalHtml ? personMarkdown : agentMarkdown;
  let spent: string | null = null;
  return (text, streaming) => {
    if (streaming && spent !== null && text.startsWith(spent)) return asPlainText(text);
    const rendered = renderMessage(markdown, text);
    spent = streaming && rendered.spent ? text : null;
    return rendered.html;
  };
}

/** The markdown step of {@link personMarkdownHtml}, before sanitizing. */
export function personMarkdownToHtml(markdown: string): string {
  return parseMarkdown(personMarkdown, markdown);
}

/** A person's message: markdown, but HTML they typed stays the literal text
 * they typed. The sanitizer still runs after, as for every message. */
export function personMarkdownHtml(markdown: string): string {
  return renderMessage(personMarkdown, markdown).html;
}
