/**
 * Whether a text selection whose release lands outside the document still
 * becomes a highlight: web-highlighter's `pressAndDrag` option, passed through
 * by `useAnnotationHighlighter` (the Viewer and every other host of the hook).
 *
 * Default: off, so a host that does not opt in (Plannotator's own apps) keeps
 * every selection exactly as before. A host passes
 * `configurePlannotatorUI({ pressAndDrag: true })` before its documents mount.
 *
 * Needs a web-highlighter that has the option. On one that does not (0.8.2),
 * the hook leaves everything as it is with the option off.
 */
export interface PressAndDragPolicy {
  on: boolean;
  /** The library's `pressAndDragThreshold` (CSS px a press must move to count as a drag); its own default when absent. */
  threshold?: number;
}

let policy: PressAndDragPolicy = { on: false };

export function setPressAndDrag(on: boolean, threshold?: number): void {
  policy = threshold === undefined ? { on } : { on, threshold };
}

export function resetPressAndDrag(): void {
  policy = { on: false };
}

export function getPressAndDrag(): PressAndDragPolicy {
  return policy;
}
