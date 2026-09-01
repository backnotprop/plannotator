/**
 * What the renderer makes of a piece of markdown, as text.
 *
 * Several features match SOURCE markdown against the RENDERED DOM: an external
 * annotation quotes `/api/plan`, which serves the source, and is then pinned by
 * searching the page. The two disagree wherever the renderer consumes syntax
 * (`**bold**`, `` `code` ``, `[a](b)`), drops a delimiter that carries no glyph
 * (a table row's `|`, a list item's `- `), or injects text of its own (a
 * bullet, an ordered numeral, an ambiguous code-file link's match count).
 *
 * That divergence has no inverse worth writing. Approximating one with regexes
 * cost this codebase four rungs of a restore ladder and still missed every case
 * where the DOM side is what diverges, because rewriting the needle cannot
 * remove text the haystack gained. So don't approximate: run the real renderer
 * over the quote and compare its output. A markdown feature added tomorrow is
 * covered the day it renders.
 *
 * Two rules make the comparison sound, and both sides must follow them:
 *
 *   1. Text the renderer injects for the UI's own sake is flagged (see
 *      `DECORATION_SELECTOR`) and excluded here AND from the document walker.
 *      This is what makes a bullet, an ordered numeral and a match-count badge
 *      simply not exist for either side, which matters because a fragment
 *      rendered alone cannot know its position in a list.
 *   2. The document is walked with `visibleText`, never `textContent`.
 *
 * Returns null when the source renders to nothing or the render throws (a
 * block needing a live DOM, KaTeX, a highlighter): callers fall back to their
 * other rungs rather than losing the annotation.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseMarkdownToBlocks } from './parser';
import { BlockRenderer } from '../components/BlockRenderer';

/**
 * Skips chrome the renderer drew: text that is not in the document.
 *
 * Two flags, because they are two different claims. `aria-hidden` says "no one
 * needs to hear this", which fits a badge that repeats its own `title`.
 * `data-decorative` says "this is not document text" WITHOUT hiding it — a list
 * bullet has to stay audible, since these list items are divs and the glyph is
 * the only thing marking them as a list.
 */
const DECORATION_SELECTOR = '[aria-hidden="true"],[data-decorative]';

export const VISIBLE_TEXT: NodeFilter = {
  acceptNode: (node) =>
    node.parentElement?.closest(DECORATION_SELECTOR)
      ? NodeFilter.FILTER_REJECT
      : NodeFilter.FILTER_ACCEPT,
};

export function visibleText(root: Node): string {
  const doc = root.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
  if (!doc) return '';
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, VISIBLE_TEXT);
  let text = '';
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) text += node.textContent || '';
  return text;
}

// Restore runs over every annotation on load, and a quote is stable for the
// life of the page. Bounded rather than an LRU: the working set is one
// document's annotations, and dropping all of it costs one re-render.
const CACHE_LIMIT = 500;
const cache = new Map<string, string | null>();

function render(source: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const blocks = parseMarkdownToBlocks(source);
    if (blocks.length === 0) return null;
    // A <template> is inert: its content is parsed but never run or laid out.
    const holder = document.createElement('template');
    holder.innerHTML = blocks
      .map((block) => renderToStaticMarkup(<BlockRenderer block={block} />))
      .join('');
    return visibleText(holder.content) || null;
  } catch {
    return null;
  }
}

export function renderMarkdownToText(source: string): string | null {
  if (!source) return null;
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const rendered = render(source);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(source, rendered);
  return rendered;
}
