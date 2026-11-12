export function scrollableEditSurface(
  editorScroller: HTMLElement | null,
  documentViewport: HTMLElement | null,
  isEditing: boolean,
): HTMLElement | null {
  // On desktop the viewport scrolls and `.cm-scroller` never overflows; only a bounded editor scrolls itself.
  if (isEditing && editorScroller && editorScroller.scrollHeight > editorScroller.clientHeight) {
    return editorScroller;
  }
  return documentViewport;
}
