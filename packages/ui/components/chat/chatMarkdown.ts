import DOMPurify from 'dompurify';
import { Marked } from 'marked';

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

/** The one safe answer when markdown or the sanitizer cannot be trusted: the
 * source as plain text, keeping its lines. */
function asPlainText(source: string): string {
  return `<p>${escapeHtml(source).replaceAll('\n', '<br>')}</p>`;
}

/**
 * Tags from the Ask AI panel's list: no scripts, no handlers, no images, so
 * this text cannot load a remote address. Attributes are tighter than that
 * list, because this HTML lands inside a host's page: `class` would hand it the
 * host's own stylesheet (a full-page `fixed` link), and `data-*` or `aria-*`
 * would let it pose as the anchors hosts read off a text part.
 */
const CHAT_PURIFY_CONFIG = {
  ALLOWED_TAGS: [...CHAT_SANITIZE_CONFIG.ALLOWED_TAGS],
  ALLOWED_ATTR: ['href', 'align'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

/** Everything the sanitizer must take out. It proves itself on this before any
 * real text, because `isSupported` is not proof: a partial DOM reports true and
 * lets scripts through. */
const PROOF_INPUT =
  '<a href="javascript:alert(1)" class="c" data-c="1" onclick="alert(2)">kept</a>' +
  '<img src="x" onerror="alert(3)"><script>alert(4)</script>';
const PROOF_FAILED = /javascript:|class=|data-c|onclick|onerror|<img|<script/i;

type Purifier = ReturnType<typeof DOMPurify>;

function buildPurifier(): Purifier | null {
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
  const proof = purifier.sanitize(PROOF_INPUT, CHAT_PURIFY_CONFIG);
  return PROOF_FAILED.test(proof) || !proof.includes('kept') ? null : purifier;
}

let provenPurifier: Purifier | null | undefined;

/** The sanitizer, once it has shown it works here. Null: nothing may go out as HTML. */
function purifierThatWorks(): Purifier | null {
  if (provenPurifier === undefined) {
    try {
      provenPurifier = buildPurifier();
    } catch {
      provenPurifier = null;
    }
  }
  return provenPurifier;
}

/**
 * `marked` has inputs that overflow the stack and inputs that take minutes:
 * nested markers (`> > > …`, `- - - …`) and long runs of inline markers, one
 * token at a time. These limits keep a single message from stopping the page.
 * The budget is checked between tokens; one long unbroken word is the case it
 * cannot reach, because that cost sits inside a single regular expression.
 */
const MARKDOWN_BUDGET_MS = 250;
const MAX_TEXT_CHARS = 256_000;
const MAX_WORD_CHARS = 8_000;

function tooMuchToParse(source: string): boolean {
  if (source.length > MAX_TEXT_CHARS) return true;
  let word = 0;
  for (let index = 0; index < source.length; index += 1) {
    word = source.charCodeAt(index) <= 32 ? 0 : word + 1;
    if (word > MAX_WORD_CHARS) return true;
  }
  return false;
}

let deadline = 0;

/** A tokenizer that matches nothing: `marked` asks it before every token. */
function checkBudget(): undefined {
  if (Date.now() > deadline) throw new Error('markdown budget spent');
  return undefined;
}

const budgetExtension = {
  extensions: [
    { name: 'chatBudgetBlock', level: 'block' as const, tokenizer: checkBudget },
    { name: 'chatBudgetInline', level: 'inline' as const, tokenizer: checkBudget },
  ],
};

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
  return markdown.parse(source, { async: false });
}

/** The one way out to the DOM. It never throws: a render that throws would take
 * the host's whole React root with it. */
function renderMessage(markdown: Marked, source: string): string {
  const purifier = purifierThatWorks();
  if (purifier === null || tooMuchToParse(source)) return asPlainText(source);
  try {
    return purifier.sanitize(parseMarkdown(markdown, source), CHAT_PURIFY_CONFIG);
  } catch {
    return asPlainText(source);
  }
}

/** An agent's text as sanitized HTML. */
export function chatMarkdownHtml(markdown: string): string {
  return renderMessage(agentMarkdown, markdown);
}

/** The markdown step of {@link personMarkdownHtml}, before sanitizing. */
export function personMarkdownToHtml(markdown: string): string {
  return parseMarkdown(personMarkdown, markdown);
}

/** A person's message: markdown, but HTML they typed stays the literal text
 * they typed. The sanitizer still runs after, as for every message. */
export function personMarkdownHtml(markdown: string): string {
  return renderMessage(personMarkdown, markdown);
}
