interface PierreAnchoring {
  idToItem?: Map<string, unknown>;
  capturePendingLayoutAnchor?: (items: Map<string, unknown>) => void;
  getScrollTop(): number;
  getTopForItem(id: string): number | null | undefined;
  getRenderedItems(): readonly { id: string }[];
}

export function anchorPastItem(viewer: unknown, itemId: string, viewportHeight: number): void {
  const view = viewer as PierreAnchoring | null | undefined;
  if (!view?.idToItem || typeof view.capturePendingLayoutAnchor !== 'function') return;
  const scrollTop = view.getScrollTop();
  const top = view.getTopForItem(itemId);
  if (top == null || top >= scrollTop) return;
  const startsOnScreen = view.getRenderedItems().some(({ id }) => {
    if (id === itemId) return false;
    const at = view.getTopForItem(id);
    return at != null && at >= scrollTop && at < scrollTop + viewportHeight;
  });
  if (!startsOnScreen) return;
  const others = new Map(view.idToItem);
  others.delete(itemId);
  view.capturePendingLayoutAnchor(others);
}

const HOLD_MS = 1_000;
const INTENT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

export function holdPlacePastItem(viewer: unknown, itemId: string, scroller: HTMLElement): void {
  const until = performance.now() + HOLD_MS;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of INTENT) scroller.removeEventListener(type, stop);
  };
  for (const type of INTENT) scroller.addEventListener(type, stop, { passive: true });
  const step = () => {
    if (performance.now() > until) return stop();
    anchorPastItem(viewer, itemId, scroller.clientHeight);
    frame = requestAnimationFrame(step);
  };
  step();
}
