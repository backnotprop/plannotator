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

/** What sits at a file's foot in full screen (an image's or a film's comment row, a phone's "Comment at"): the toolbar, the chips and the toast keep above it. */
export const FILE_FOOT_ROW = '[data-image-composer], [data-file-foot]';

/**
 * The file's foot row as drawn: the first FILE_FOOT_ROW that is not hidden (full screen's composer keeps
 * the comment row drawn but `hidden` while the card is minimized, and the pill is then the foot).
 */
export function fileFootRow(section: ParentNode): HTMLElement | null {
  for (const row of section.querySelectorAll<HTMLElement>(FILE_FOOT_ROW)) if (!row.closest('[hidden]')) return row;
  return null;
}
