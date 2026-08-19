function copyTextWithFallback(text: string, focusOwner?: HTMLElement): boolean {
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
    // Without clipboardData there is nothing to write into; leave the native
    // copy untouched (preventDefault would only suppress it) and stay
    // unsuccessful so the textarea path below runs.
    if (!event.clipboardData) return;
    event.preventDefault();
    event.clipboardData.setData('text/plain', text);
    copied = true;
  };
  document.addEventListener('copy', handleCopy);
  try {
    // Success requires BOTH: our handler actually wrote the payload via
    // setData, AND execCommand reported the copy command ran.
    copied = document.execCommand('copy') && copied;
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', handleCopy);
  }

  if (!copied) {
    const textarea = document.createElement('textarea');
    textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    // Marker so focus-sensitive surfaces (PopoutDialog's focus-out close
    // guard) can recognize the transient fallback textarea and not treat the
    // focus shift as leaving the dialog.
    textarea.setAttribute('data-clipboard-fallback', 'true');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      // Clipboard access can be denied by the embedding browser. The caller
      // still regains the same document focus and selection below.
      copied = false;
    }
    textarea.remove();
  }

  if (activeElement?.isConnected) {
    activeElement.focus({ preventScroll: true });
  } else if (focusOwner?.isConnected) {
    focusOwner.focus({ preventScroll: true });
  }
  if (selection && savedRanges.length > 0) {
    selection.removeAllRanges();
    savedRanges.forEach((range) => selection.addRange(range));
  }

  return copied;
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

/**
 * Copy text to the clipboard, falling back to the legacy copy-event /
 * execCommand path when the async Clipboard API is unavailable (insecure
 * contexts such as remote-mode plain HTTP) or rejects. Resolves `true` when
 * a copy strategy succeeded and `false` otherwise. Never throws.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const clipboardWrite = navigator.clipboard?.writeText(text);
    if (clipboardWrite) {
      await clipboardWrite;
      return true;
    }
  } catch {
    // Clipboard API absent, threw synchronously, or rejected — fall back to
    // the legacy copy-event path below.
  }
  try {
    return copyTextWithFallback(text);
  } catch {
    return false;
  }
}
