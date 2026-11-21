/**
 * Calls `shifted` when something in the list's scroll box can move a row without a scroll: a card or a row
 * comes or goes, or a group above it grows (the notifications card, a thread that arrives). The open row's action
 * layer (rowSwipe.ts) is placed in the box's own coordinates, so it is placed again then, under its row.
 * Returns the cleanup.
 */
export function watchListShift(body: HTMLElement, skip: HTMLElement, shifted: () => void): () => void {
  const view = body.ownerDocument.defaultView ?? window;
  if (typeof view.MutationObserver === 'undefined') return () => {};
  const sizes = typeof view.ResizeObserver === 'undefined' ? null : new view.ResizeObserver(() => shifted());
  const observeChildren = () => {
    if (!sizes) return;
    sizes.disconnect();
    for (const child of body.children) if (child !== skip) sizes.observe(child);
  };
  observeChildren();
  const tree = new view.MutationObserver((records) => {
    if (records.some((r) => r.target === body)) observeChildren();
    shifted();
  });
  tree.observe(body, { childList: true, subtree: true });
  return () => {
    sizes?.disconnect();
    tree.disconnect();
  };
}
