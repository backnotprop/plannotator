export const STRANGERS_MARKUP = '.ib-prr-desc, .ib-prd';

export function selectionToolbarShowing(doc: Document = document): boolean {
  for (const el of doc.querySelectorAll('[data-pn-annotation-toolbar-row], [data-quick-label-picker]')) {
    if (!el.closest(STRANGERS_MARKUP) && el.getClientRects().length > 0) return true;
  }
  return false;
}
