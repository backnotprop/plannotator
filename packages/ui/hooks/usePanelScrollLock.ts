import { useEffect } from 'react';

const LOCK_ATTRIBUTE = 'data-pn-panel-scroll-lock';
const BOUNDARY = '[data-pn-panel-side], [data-pn-compact-plan-stage], [role="dialog"], [role="menu"], [role="listbox"]';
let lockCount = 0;
let previousAttribute: string | null = null;

/** Keep native list scrolling, but never hand a panel's touches to the page beneath it. */
export function usePanelScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    if (lockCount++ === 0) {
      previousAttribute = root.getAttribute(LOCK_ATTRIBUTE);
      root.setAttribute(LOCK_ATTRIBUTE, 'true');
    }

    let point: { id: number; x: number; y: number } | null = null;
    const reset = () => { point = null; };
    const start = (event: TouchEvent) => {
      reset();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      point = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
    };
    const move = (event: TouchEvent) => {
      if (!point || event.touches.length !== 1) return reset();
      const touch = event.touches[0];
      if (touch.identifier !== point.id) return reset();
      const dx = touch.clientX - point.x;
      const dy = touch.clientY - point.y;
      point = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
      // Horizontal panel swipes, sideways scrollers and pinch zoom keep their own handling.
      if (Math.abs(dy) <= Math.abs(dx)) return;
      const path = event.composedPath().filter((node): node is Element => node instanceof Element);
      const boundary = path.find(node => node.matches(BOUNDARY));
      if (boundary) {
        for (const node of path) {
          const max = node.scrollHeight - node.clientHeight;
          if (max > 1 && /^(auto|scroll|overlay)$/.test(getComputedStyle(node).overflowY)
            && (dy < 0 ? node.scrollTop < max - 1 : node.scrollTop > 1)) return;
          if (node === boundary) break;
        }
      }
      // iOS may chain through a non-scrollable header or a list boundary despite
      // overscroll-behavior. Cancel only that hand-off, never a list's native scroll.
      if (event.cancelable) event.preventDefault();
    };

    document.addEventListener('touchstart', start, { capture: true, passive: true });
    document.addEventListener('touchmove', move, { capture: true, passive: false });
    document.addEventListener('touchend', reset, true);
    document.addEventListener('touchcancel', reset, true);
    return () => {
      document.removeEventListener('touchstart', start, true);
      document.removeEventListener('touchmove', move, true);
      document.removeEventListener('touchend', reset, true);
      document.removeEventListener('touchcancel', reset, true);
      if (--lockCount === 0) {
        if (previousAttribute === null) root.removeAttribute(LOCK_ATTRIBUTE);
        else root.setAttribute(LOCK_ATTRIBUTE, previousAttribute);
        previousAttribute = null;
      }
    };
  }, [active]);
}
