import { useEffect, useRef } from 'react';
import { sidewaysOwner } from './useSwipeStep';

interface EdgeDrag {
  onMove: (distance: number, closing: boolean) => void;
  onEnd: (distance: number | null, closing: boolean) => void;
}

interface EdgeSwipeOptions {
  enabled: boolean;
  onOpenLeft?: () => void;
  onOpenRight?: () => void;
  drag?: Partial<Record<'left' | 'right', EdgeDrag>>;
  panel?: {
    side: 'left' | 'right';
    selector: string;
    onClose: () => void;
    trackDrag?: boolean;
  };
}

/** Open from a viewport edge; dismiss an open panel with an outward swipe inside it. */
export function useEdgeSwipe(options: EdgeSwipeOptions): void {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!options.enabled) return;

    let gesture: {
      id: number;
      x: number;
      y: number;
      side: 'left' | 'right';
      direction: 1 | -1;
      panel: Element | null;
      path: EventTarget[];
      claimed: boolean;
      drag?: EdgeDrag;
    } | null = null;
    const reset = () => {
      const current = gesture;
      gesture = null;
      if (current?.claimed) current.drag?.onEnd(null, !!current.panel);
    };
    const hasSelection = () => !!window.getSelection()?.toString();
    const hasBlockingModal = (panel: Element | null) => Array.from(
      document.querySelectorAll('[aria-modal="true"], dialog[open], [data-pn-panel-side]'),
    ).some(modal => modal !== panel && modal.getAttribute('aria-hidden') !== 'true');

    const start = (event: TouchEvent) => {
      reset();
      const panelOptions = latest.current.panel;
      const panel = panelOptions ? document.querySelector(panelOptions.selector) : null;
      if (panelOptions && !panel) return;
      if (event.touches.length !== 1 || hasSelection() || hasBlockingModal(panel)) return;
      const path = event.composedPath();
      if (panel && !path.includes(panel)) return;
      // Ignore portals, lightboxes and other surfaces outside the compact app shell.
      if (!path.some(node => node instanceof Element
        && node.matches('[data-pn-compact-touch-layout="true"]'))) return;
      const touch = event.touches[0];
      const side = panelOptions?.side ?? (touch.clientX <= 24 ? 'left'
        : touch.clientX >= window.innerWidth - 24 ? 'right' : null);
      if (!side || (!panel && !(side === 'left' ? latest.current.onOpenLeft : latest.current.onOpenRight))) return;
      const direction = panel ? (side === 'left' ? -1 : 1) : (side === 'left' ? 1 : -1);
      if (sidewaysOwner(path, direction === 1 ? -1 : 1)) return;
      const drag = !panel || panelOptions?.trackDrag ? latest.current.drag?.[side] : undefined;
      gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY, side, direction, panel, path, claimed: false, drag };
    };

    const move = (event: TouchEvent) => {
      if (!gesture) return;
      if (event.touches.length !== 1 || hasSelection() || hasBlockingModal(gesture.panel)) return reset();
      const touch = event.touches[0];
      if (touch.identifier !== gesture.id) return reset();
      const dx = (touch.clientX - gesture.x) * gesture.direction;
      const dy = Math.abs(touch.clientY - gesture.y);
      if (!gesture.claimed) {
        if (Math.max(Math.abs(dx), dy) < 12) return;
        // Lock the direction once: a vertical scroll must never become a panel swipe.
        if (dx <= dy * 1.5 || sidewaysOwner(gesture.path, gesture.direction === 1 ? -1 : 1)) return reset();
        gesture.claimed = true;
      }
      if (!event.cancelable) return reset(); // The browser already owns this gesture.
      event.preventDefault();
      gesture.drag?.onMove(Math.max(0, dx), !!gesture.panel);
    };

    const end = (event: TouchEvent) => {
      const current = gesture;
      if (!current?.claimed || event.touches.length || hasSelection() || hasBlockingModal(current.panel)) return reset();
      const touch = Array.from(event.changedTouches).find(t => t.identifier === current.id);
      if (!touch) return reset();
      gesture = null;
      const dx = (touch.clientX - current.x) * current.direction;
      if (current.drag) {
        current.drag.onEnd(Math.max(0, dx), !!current.panel);
        return;
      }
      if (dx < 48 || dx <= Math.abs(touch.clientY - current.y) * 1.5) return;
      const callback = current.panel ? latest.current.panel?.onClose
        : current.side === 'left' ? latest.current.onOpenLeft : latest.current.onOpenRight;
      callback?.();
    };

    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', reset);
    return () => {
      reset();
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', reset);
    };
  }, [options.enabled, options.panel?.side, options.panel?.selector]);
}
