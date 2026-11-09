/**
 * Inbox search's landing highlight: the query's words in the one message a
 * search result opened, painted with the CSS Custom Highlight API, so the
 * DOM is never changed (annotations, question cards and the reader's own
 * selection are untouched). Matching is @plannotator/core/inbox-search's, the
 * same tokens the server's index matched. Where the API is missing (an older
 * browser, the DOM tests) nothing is painted and the landing still focuses
 * and rings the message.
 */

import { inboxSearchRanges } from '@plannotator/core/inbox-search';
import { flushPendingHighlights } from '@plannotator/ui/utils/codeHighlight';

/** The highlight's name in `CSS.highlights` (inbox.css styles `::highlight(ib-search-hit)`). */
export const SEARCH_HIGHLIGHT = 'ib-search-hit';

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function registry(): { highlights: HighlightRegistry; Highlight: new (...ranges: Range[]) => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!css?.highlights || typeof Highlight !== 'function') return null;
  return { highlights: css.highlights, Highlight };
}

/** The ranges of `terms` in the text under `root`, skipping what `skip` matches (a message's head row, folded or open). */
export function searchHitRanges(root: Node, terms: readonly string[], skip = '[data-fold-head], [data-open-head], script, style, textarea'): Range[] {
  const out: Range[] = [];
  if (terms.length === 0) return out;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (const [start, end] of inboxSearchRanges(node.data, terms, { prefixAll: true })) {
      const range = doc.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      out.push(range);
    }
  }
  return out;
}

/** Paint the terms under `root`; returns how many ranges, and the way to clear them. */
export function highlightSearchHits(root: Node, terms: readonly string[]): { count: number; clear: () => void } {
  // A fence still waiting to be highlighted (off screen) would swap its text nodes later and drop these ranges.
  flushPendingHighlights(root);
  const api = registry();
  const ranges = searchHitRanges(root, terms);
  if (!api || ranges.length === 0) return { count: ranges.length, clear: () => {} };
  api.highlights.set(SEARCH_HIGHLIGHT, new api.Highlight(...ranges));
  return { count: ranges.length, clear: () => api.highlights.delete(SEARCH_HIGHLIGHT) };
}
