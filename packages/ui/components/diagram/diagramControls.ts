/**
 * The canvas's own chrome, and why a pointer event on it must stop there.
 *
 * `DiagramCanvas` resolves what a click means over EVERYTHING under the
 * pointer (`elementsFromPoint`, node → edge → cluster), because the edge hit
 * layer sits above the nodes. The controls painted over the canvas — the
 * zoom strip, the comment composer, the popout's own chrome — are not in the
 * svg, so that walk skipped straight past them to whatever part happened to
 * be underneath: pressing Zoom out over a node opened the composer on that
 * node, and a press on the strip could start a pan.
 *
 * So a pointer event whose composed path contains a control surface never
 * resolves a target, never opens the composer, and never starts a pan. It is
 * the path rather than the point: a control knows it is a control, while a
 * rectangle test would have to be kept in step with the layout.
 *
 * Mark new chrome with `data-diagram-control`. Buttons and toolbars count
 * without marking, since anything the pointer can press is chrome by
 * definition.
 */
export const DIAGRAM_CONTROL_SELECTOR =
  '[data-diagram-control],[data-diagram-composer],[data-diagram-source-pane],[data-diagram-popout-chrome],button,[role="toolbar"],[role="button"],input,textarea,select,a[href]';

function isElement(value: unknown): value is Element {
  return typeof (value as Element | null)?.matches === 'function';
}

/** Whether this pointer event was aimed at the canvas's chrome rather than
 * at the diagram. */
export function isDiagramControlEvent(event: { target: EventTarget | null; nativeEvent?: Event }): boolean {
  const native = event.nativeEvent ?? (event as unknown as Event);
  const path = typeof native?.composedPath === 'function' ? native.composedPath() : [];
  for (const entry of path) {
    if (isElement(entry) && entry.matches(DIAGRAM_CONTROL_SELECTOR)) return true;
  }
  // `composedPath()` is empty once dispatch has finished, and jsdom-class
  // DOMs may not implement it at all: the target's own ancestry is the same
  // answer for everything but a shadow root.
  const target = event.target;
  return isElement(target) && target.closest(DIAGRAM_CONTROL_SELECTOR) !== null;
}
