/**
 * `web-highlighter` cannot select inside a `<pre>`, so fenced code is annotated as an
 * all-or-nothing block: one `<mark data-bind-id>` that is the `<code>` element's only child and
 * holds everything the fence renders.
 */
import { AnnotationType } from '../types';

export function codeBlockMarkClassName(type: AnnotationType): string {
  return `annotation-highlight ${
    type === AnnotationType.DELETION ? 'deletion' : type === AnnotationType.COMMENT ? 'comment' : ''
  }`.trim();
}

/** Wrap everything inside `codeEl` in a single annotation mark and return it. */
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
