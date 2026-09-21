/**
 * Which element a markdown edit session's scroll offset actually lives on.
 *
 * The Viewer ↔ MarkdownEditor swap replaces the document area's children, and a
 * real browser clamps the scroll container to the top the moment the old subtree
 * leaves it — that is the jump #1479 reports. Carrying the offset across the
 * swap needs the right target, and the target depends on the shell:
 *
 *   - The desktop layout leaves the editor unbounded, so CodeMirror grows to
 *     full content height inside the document viewport: the VIEWPORT scrolls and
 *     `.cm-scroller` never overflows (restoring into it is a silent no-op).
 *   - A height-bounded shell (compact touch) bounds the editor, so CodeMirror
 *     scrolls itself and `.cm-scroller` is the scroller.
 *
 * Resolve the element that can actually scroll when the offset is READ (before
 * the swap): the surface on screen has settled by then, so its overflow test is
 * trustworthy. Restoring is deliberately not routed through this test — the
 * surface that just mounted has no reliable measurement yet; see the restore
 * effect in `App.tsx`.
 */
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
