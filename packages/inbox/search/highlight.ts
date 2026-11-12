import { inboxSearchRanges } from '@plannotator/core/inbox-search';
import { flushPendingHighlights } from '@plannotator/ui/utils/codeHighlight';

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

export function highlightSearchHits(root: Node, terms: readonly string[]): { count: number; clear: () => void } {
  flushPendingHighlights(root);
  const api = registry();
  const ranges = searchHitRanges(root, terms);
  if (!api || ranges.length === 0) return { count: ranges.length, clear: () => {} };
  api.highlights.set(SEARCH_HIGHLIGHT, new api.Highlight(...ranges));
  return { count: ranges.length, clear: () => api.highlights.delete(SEARCH_HIGHLIGHT) };
}
