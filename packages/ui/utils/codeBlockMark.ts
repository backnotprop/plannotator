/**
 * The annotation `<mark>` that covers a whole fenced code block.
 *
 * `web-highlighter` cannot select inside a `<pre>`, so fenced code is annotated
 * as an all-or-nothing block: one `<mark data-bind-id>` that is the `<code>`
 * element's only child and holds everything the fence renders. Several places
 * need to (re)paint exactly that shape — creating an annotation, and restoring
 * one after `applyHighlight` replaced the element's children — so the DOM
 * contract lives here rather than being written out twice.
 *
 * The children are MOVED into the mark, never flattened to text. Highlighted
 * fences render as Shiki token `<span>`s, and flattening would drop the
 * palette's colours on the floor the moment a block was annotated or
 * re-themed.
 */
import { AnnotationType } from '../types';

export function codeBlockMarkClassName(type: AnnotationType): string {
  return `annotation-highlight ${
    type === AnnotationType.DELETION ? 'deletion' : type === AnnotationType.COMMENT ? 'comment' : ''
  }`.trim();
}

/**
 * Wrap everything inside `codeEl` in a single annotation mark and return it.
 *
 * Any mark a previous annotation left behind is unwrapped first, so a second
 * annotation on the same block replaces the first (what has always happened)
 * instead of nesting inside it.
 */
export function paintCodeBlockMark(
  codeEl: Element,
  id: string,
  type: AnnotationType,
): HTMLElement {
  codeEl.querySelectorAll('mark[data-bind-id]').forEach((existing) => {
    const parent = existing.parentNode;
    if (!parent) return;
    while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
    existing.remove();
  });

  const doc = codeEl.ownerDocument ?? document;
  const wrapper = doc.createElement('mark');
  wrapper.className = codeBlockMarkClassName(type);
  wrapper.dataset.bindId = id;
  while (codeEl.firstChild) wrapper.appendChild(codeEl.firstChild);
  codeEl.replaceChildren(wrapper);
  return wrapper;
}
