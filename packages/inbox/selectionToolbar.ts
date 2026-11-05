/**
 * A PR's description and the comments in its details. Their raw HTML keeps `data-*`, and a diagram's label keeps classes
 * too, so what they draw can copy the marks the window's own overlays carry. Nothing in them ever stands for one of them.
 */
export const STRANGERS_MARKUP = '.ib-prr-desc, .ib-prd';

/**
 * Words selected in an agent's message open ui's selection toolbar (approval
 * "inbox-message-comments"). While it, or its label picker, is on screen it
 * owns the keyboard as it does on an attached file: Escape closes it, and a
 * printable key starts a comment with that letter. The window's own keys (the
 * thread's Escape, E, Z, j, k, n) stand down meanwhile.
 */
export function selectionToolbarShowing(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll('[data-pn-annotation-toolbar-row], [data-quick-label-picker]')) {
    if (!el.closest(STRANGERS_MARKUP) && el.getClientRects().length > 0) return true;
  }
  return false;
}
