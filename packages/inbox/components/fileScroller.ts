/** The element that scrolls the open file (a document, code, or an image at its own size). */
export function scrollerOf(pane: HTMLElement | null): HTMLElement | null {
  if (!pane) return null;
  // The file's own, never a linked Markdown document drawn over it.
  const doc = pane.querySelector<HTMLElement>('.ib-docscroll:not(.ib-linkeddoc)');
  if (doc) return doc;
  const code = pane.querySelector('.ib-codeview diffs-container')?.shadowRoot?.querySelector<HTMLElement>('[data-code]');
  if (code) return code;
  return pane.querySelector<HTMLElement>('.ib-imgstage');
}
