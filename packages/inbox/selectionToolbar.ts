export const STRANGERS_MARKUP = '.ib-prr-desc, .ib-prd';

/** While the selection toolbar or its label picker is on screen it owns the keyboard (Escape closes, a printable key starts a comment); the window's own keys stand down. */
export function selectionToolbarShowing(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll('[data-pn-annotation-toolbar-row], [data-quick-label-picker]')) {
    if (!el.closest(STRANGERS_MARKUP) && el.getClientRects().length > 0) return true;
  }
  return false;
}
