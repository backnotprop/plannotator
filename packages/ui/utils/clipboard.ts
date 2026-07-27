function copyTextWithFallback(text: string, focusOwner: HTMLElement): void {
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const selection = window.getSelection();
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange())
    : [];
  let copied = false;

  const handleCopy = (event: ClipboardEvent) => {
    event.preventDefault();
    event.clipboardData?.setData('text/plain', text);
    copied = true;
  };
  document.addEventListener('copy', handleCopy);
  try {
    copied = document.execCommand('copy') || copied;
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', handleCopy);
  }

  if (!copied) {
    const textarea = document.createElement('textarea');
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } catch {
      // Clipboard access can be denied by the embedding browser. The caller
      // still regains the same document focus and selection below.
    }
    textarea.remove();
  }

  if (activeElement?.isConnected) {
    activeElement.focus({ preventScroll: true });
  } else if (focusOwner.isConnected) {
    focusOwner.focus({ preventScroll: true });
  }
  if (selection && savedRanges.length > 0) {
    selection.removeAllRanges();
    savedRanges.forEach((range) => selection.addRange(range));
  }
}

/**
 * Copy text without stealing focus or discarding the host document's native
 * selection. Falls back to the copy event for restricted browser contexts.
 */
export function copyTextPreservingFocus(
  text: string,
  focusOwner: HTMLElement,
): void {
  try {
    const clipboardWrite = navigator.clipboard?.writeText(text);
    if (clipboardWrite) {
      void clipboardWrite.catch(() => {
        copyTextWithFallback(text, focusOwner);
      });
      return;
    }
  } catch {
    // Fall through when a browser exposes Clipboard but rejects access
    // synchronously (for example, in a restricted embedded document).
  }
  copyTextWithFallback(text, focusOwner);
}
