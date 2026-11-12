/**
 * Reply with a quote, the window's side (approval "inbox-reply-quote", issue #3109). ↩ on an older message, or on
 * any message with words selected in it, puts one quiet line in the reply box naming that message (or those words);
 * the reply sends it as `quote` and the Inbox writes the lead the agent reads (@plannotator/core/inbox-reply-quote).
 * The sent reply shows the same line, and a press on it goes to the original.
 *
 * The person-facing words are all in REPLY_QUOTE_WORDS (not yet approved word for word: one place, one edit).
 */

import { inboxReplyQuoteExcerpt } from '@plannotator/core/inbox-reply-quote';
import type { InboxMessageWire, InboxReplyQuote } from '@plannotator/core/inbox-types';

/** The person-facing words of the quote (tooltips and what a screen reader hears). */
export const REPLY_QUOTE_WORDS = {
  /** The × on the box's quote line. */
  remove: 'Remove quote',
  /** The sent reply's quote line. */
  goTo: 'Go to the message',
  /** What a screen reader hears for the quote: "Replying to Claude Code's message from 10:04 AM". */
  label: (who: string, time: string, words: boolean) => `Replying to ${words ? 'words in ' : ''}${who === 'You' ? 'your message' : `${who}'s message`}${time ? ` from ${time}` : ''}`,
  /** Said when the × takes the quote away. */
  removed: 'Quote removed.',
} as const;

/** The most characters of selected words a quote keeps (the Inbox refuses more: INBOX_MESSAGE_COMMENT_QUOTE_MAX). */
const SELECTED_MAX = 20_000;

/** The quote's text as its line shows it: the selected words in quotes, else the message's first words. */
export function quoteLineText(message: Pick<InboxMessageWire, 'author' | 'body'>, words: string | undefined): string {
  if (words !== undefined) return `“${words.replace(/\s+/g, ' ').trim()}”`;
  return inboxReplyQuoteExcerpt(message);
}

/**
 * The words selected inside one message's body (`root`, the message's article), as shown on screen; null when the
 * selection is empty or reaches outside its text (the head row, another message).
 */
export function selectedWordsIn(root: Element | null): string | null {
  if (!root) return null;
  const selection = root.ownerDocument?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const inside = (node: Node | null) => {
    const element = node instanceof Element ? node : (node?.parentElement ?? null);
    return !!element && root.contains(element) && !element.closest('[data-open-head], [data-fold-head], button, textarea, input');
  };
  if (!inside(selection.anchorNode) || !inside(selection.focusNode)) return null;
  const words = selection.toString().trim();
  if (words === '') return null;
  return words.length > SELECTED_MAX ? words.slice(0, SELECTED_MAX) : words;
}

/**
 * ↩ with nothing selected quotes the message only when an agent wrote after it: then the reply could be read as an
 * answer to that later message. The newest agent message, followed only by the person's own messages or the Inbox's
 * notes, is the one a plain reply answers anyway, so its ↩ is a plain Reply, as is ↩ on the person's newest message.
 */
export function arrowQuotesWhole(messages: readonly InboxMessageWire[], id: string): boolean {
  const at = messages.findIndex((m) => m.id === id);
  return at >= 0 && messages.slice(at + 1).some((m) => m.author.kind === 'agent');
}

/** The quote the reply carries to the Inbox, with the quoted message's time as this window shows it. */
export function quoteToSend(quote: InboxReplyQuote | null, messages: readonly InboxMessageWire[], time: (iso: string) => string): { of: string; words?: string; time?: string } | undefined {
  if (!quote) return undefined;
  const message = messages.find((m) => m.id === quote.of);
  if (!message) return undefined;
  const at = time(message.created_at);
  return { of: quote.of, ...(quote.words !== undefined ? { words: quote.words } : {}), ...(at ? { time: at } : {}) };
}

/** The highlight's name in `CSS.highlights` (inbox.css styles `::highlight(ib-quote-words)`). */
export const QUOTE_HIGHLIGHT = 'ib-quote-words';

/**
 * Where `words` are in the text under `root`, matched without regard to spaces and line breaks (a selection across
 * paragraphs reads with line breaks the text nodes do not hold). Null when they are not there.
 */
export function quoteRangeIn(root: Element, words: string): Range | null {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[data-open-head], [data-fold-head], script, style, textarea') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  // Every character that is not a space, with the text node and offset it came from.
  const chars: { node: Text; at: number }[] = [];
  let text = '';
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i += 1) {
      if (/\s/.test(node.data[i]!)) continue;
      chars.push({ node, at: i });
      text += node.data[i];
    }
  }
  const wanted = words.replace(/\s+/g, '');
  if (wanted === '') return null;
  const start = text.indexOf(wanted);
  if (start < 0) return null;
  const first = chars[start]!;
  const last = chars[start + wanted.length - 1]!;
  const range = doc.createRange();
  range.setStart(first.node, first.at);
  range.setEnd(last.node, last.at + 1);
  return range;
}

/**
 * Tint the quoted words in the original for a moment (the CSS Custom Highlight API, so the message's DOM and the
 * comment highlights stay as they are). Where the API is missing nothing is painted; the jump still lands.
 */
export function flashQuoteWords(root: Element, words: string, ms = 1800): void {
  const css = (globalThis as { CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== 'function') return;
  const range = quoteRangeIn(root, words);
  if (!range) return;
  css.highlights.set(QUOTE_HIGHLIGHT, new Highlight(range));
  setTimeout(() => css.highlights?.delete(QUOTE_HIGHLIGHT), ms);
}
