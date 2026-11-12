import { useEffect, useRef } from 'react';

export const HIGHLIGHT_COMPOSER_ATTR = 'data-highlight-composer';

const COMPOSER_SELECTOR = `[data-comment-popover], [${HIGHLIGHT_COMPOSER_ATTR}]`;

function isEditable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable;
}

export function copyHasOwnSelection(event: ClipboardEvent): boolean {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try {
      if (target.selectionStart !== null && target.selectionStart !== target.selectionEnd) return true;
    } catch {
    }
  }
  const owner = target instanceof Node ? target.ownerDocument : null;
  const live = (owner ?? document).getSelection();
  return !!live && !live.isCollapsed && live.toString().length > 0;
}

export function copyFromOtherField(event: ClipboardEvent): boolean {
  const target = event.target;
  return isEditable(target) && !target.closest(COMPOSER_SELECTOR);
}

export function writeHighlightCopy(event: ClipboardEvent, text: string): boolean {
  if (event.defaultPrevented || !text || !event.clipboardData) return false;
  if (copyHasOwnSelection(event) || copyFromOtherField(event)) return false;
  event.preventDefault();
  event.clipboardData.setData('text/plain', text);
  return true;
}

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
