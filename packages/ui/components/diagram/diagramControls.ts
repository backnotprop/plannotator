export const DIAGRAM_CONTROL_SELECTOR =
  '[data-diagram-control],[data-diagram-composer],[data-diagram-source-pane],[data-diagram-popout-chrome],button,[role="toolbar"],[role="button"],input,textarea,select,a[href]';

function isElement(value: unknown): value is Element {
  return typeof (value as Element | null)?.matches === 'function';
}

export function isDiagramControlEvent(event: { target: EventTarget | null; nativeEvent?: Event }): boolean {
  const native = event.nativeEvent ?? (event as unknown as Event);
  const path = typeof native?.composedPath === 'function' ? native.composedPath() : [];
  for (const entry of path) {
    if (isElement(entry) && entry.matches(DIAGRAM_CONTROL_SELECTOR)) return true;
  }
  const target = event.target;
  return isElement(target) && target.closest(DIAGRAM_CONTROL_SELECTOR) !== null;
}
