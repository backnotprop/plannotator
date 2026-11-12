export function scrollableEditSurface(
  editorScroller: HTMLElement | null,
  documentViewport: HTMLElement | null,
  isEditing: boolean,
): HTMLElement | null {
  if (isEditing && editorScroller && editorScroller.scrollHeight > editorScroller.clientHeight) {
    return editorScroller;
  }
  return documentViewport;
}
