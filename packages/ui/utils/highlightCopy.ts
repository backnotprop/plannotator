import { useEffect, useRef } from 'react';

/**
 * Ctrl+C / Cmd+C while a highlight stands in for the person's selection.
 *
 * The annotation surfaces take the browser's selection away once they mark it:
 * web-highlighter clears it on mouseup, a composer's textarea takes focus, the
 * plan diff turns a drag into a block composer, code review turns it into a
 * line range. The native copy then has nothing to copy. These put the
 * highlighted text into the copy event instead, as plain text (rich text is
 * the toolbar's Copy button only, the owner's call on #2191), unless the
 * person has a selection of their own: text selected in a field or anywhere
 * in the page always copies natively. A field that is not the highlight's
 * composer (a reply box, a search field) keeps the browser's own copy too.
 */

/**
 * Marks a highlight's composer for `writeHighlightCopy`: a field inside it
 * with nothing selected (the empty comment box, or a caret after typed words)
 * copies the highlight. `CommentPopover` is recognised by its own
 * `data-comment-popover`; another composer carries this attribute.
 */
export const HIGHLIGHT_COMPOSER_ATTR = 'data-highlight-composer';

const COMPOSER_SELECTOR = `[data-comment-popover], [${HIGHLIGHT_COMPOSER_ATTR}]`;

function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable;
}

/** True when the copy belongs to a selection the person made themselves. */
export function copyHasOwnSelection(event: ClipboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try {
      if (target.selectionStart !== null && target.selectionStart !== target.selectionEnd) return true;
    } catch {
      // An input type without a text selection (checkbox, number).
    }
  }
  const owner = target instanceof Node ? target.ownerDocument : null;
  const live = (owner ?? document).getSelection();
  return !!live && !live.isCollapsed && live.toString().length > 0;
}

/** True when the copy comes from a field other than a highlight's composer: the browser keeps it. */
export function copyFromOtherField(event: ClipboardEvent): boolean {
  const target = event.target;
  return isEditable(target) && !target.closest(COMPOSER_SELECTOR);
}

/**
 * Writes `text` into `event` when it should; returns whether it did. Leaves an
 * event another handler already took, an empty highlight, the person's own
 * selection and a copy from another field alone.
 */
export function writeHighlightCopy(event: ClipboardEvent, text: string): boolean {
  if (event.defaultPrevented || !text || !event.clipboardData) return false;
  if (copyHasOwnSelection(event) || copyFromOtherField(event)) return false;
  event.preventDefault();
  event.clipboardData.setData('text/plain', text);
  return true;
}

/** While `text` is non-empty, Ctrl+C / Cmd+C copies it (see writeHighlightCopy). */
export function useHighlightCopy(text: string | null | undefined): void {
  const textRef = useRef(text);
  textRef.current = text;
  const active = !!text;
  useEffect(() => {
    if (!active) return;
    const onCopy = (event: ClipboardEvent) => {
      const current = textRef.current;
      if (current) writeHighlightCopy(event, current);
    };
    document.addEventListener('copy', onCopy);
    return () => document.removeEventListener('copy', onCopy);
  }, [active]);
}
