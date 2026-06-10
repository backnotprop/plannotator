import { useState, useRef, useCallback } from 'react';
import { storage } from '../utils/storage';

interface UseResizablePanelOptions {
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
  /**
   * When provided, dragging the panel narrower than `snapCloseRatio * minWidth`
   * snaps it shut (calls this) instead of clamping at minWidth.
   */
  onSnapClose?: () => void;
  snapCloseRatio?: number;
  /**
   * Imperative live-apply. When provided, the drag drives the width through this
   * callback ONCE PER FRAME and does NOT call setState — so the host component
   * never re-renders mid-drag (buttery on heavy hosts). React state is committed
   * once on release. When omitted, the width is driven through React state
   * (still rAF-coalesced).
   */
  apply?: (width: number) => void;
}

export interface ResizeHandleProps {
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  /** touch-action: none so touch drags don't scroll-hijack. */
  style: React.CSSProperties;
}

export function useResizablePanel({
  storageKey,
  defaultWidth = 288,
  minWidth = 200,
  maxWidth = 600,
  side = 'right',
  onSnapClose,
  snapCloseRatio = 0.6,
  apply,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(() => {
    const saved = storage.getItem(storageKey);
    if (saved) {
      const n = Number(saved);
      if (!Number.isNaN(n) && n >= minWidth && n <= maxWidth) return n;
    }
    return defaultWidth;
  });

  const [isDragging, setIsDragging] = useState(false);

  // Live/committed width. Drag math reads/writes this without re-rendering.
  const widthRef = useRef(width);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);
  const snappedRef = useRef(false);
  const latestXRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  // Latest callbacks via refs so the rAF loop always sees fresh values.
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const onSnapCloseRef = useRef(onSnapClose);
  onSnapCloseRef.current = onSnapClose;

  // rAF tick: compute the width from the most recent pointer position and apply
  // it. At most one DOM/state write per frame regardless of pointer-event rate.
  const flush = useCallback(() => {
    rafRef.current = null;
    if (!draggingRef.current) return;
    const delta =
      side === 'right'
        ? startXRef.current - latestXRef.current
        : latestXRef.current - startXRef.current;
    const raw = startWidthRef.current + delta;

    // Drag-to-snap-shut.
    if (onSnapCloseRef.current && raw < minWidth * snapCloseRatio) {
      snappedRef.current = true;
      draggingRef.current = false;
      widthRef.current = startWidthRef.current;
      applyRef.current?.(startWidthRef.current);
      storage.setItem(storageKey, String(startWidthRef.current));
      setWidth(startWidthRef.current);
      setIsDragging(false);
      onSnapCloseRef.current();
      return;
    }

    const w = Math.min(maxWidth, Math.max(minWidth, raw));
    widthRef.current = w;
    if (applyRef.current) applyRef.current(w);
    else setWidth(w);
  }, [side, minWidth, maxWidth, snapCloseRatio, storageKey]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only primary button / touch / pen.
      if (e.button !== 0) return;
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = widthRef.current;
      latestXRef.current = e.clientX;
      snappedRef.current = false;
      draggingRef.current = true;
      setIsDragging(true);

      // Native window listeners — fire for EVERY pointer move anywhere on screen,
      // including past the window edge and faster than the cursor. This is the
      // reliable path (React's synthetic onPointerMove on the tiny handle drops
      // moves once the pointer leaves it).
      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        latestXRef.current = ev.clientX;
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      function onUp() {
        const wasSnapped = snappedRef.current;
        draggingRef.current = false;
        snappedRef.current = false;
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        setIsDragging(false);
        if (!wasSnapped) {
          // Commit the live width to React state + persist.
          setWidth(widthRef.current);
          storage.setItem(storageKey, String(widthRef.current));
        }
        cleanup();
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [flush, storageKey],
  );

  const resetWidth = useCallback(() => {
    widthRef.current = defaultWidth;
    applyRef.current?.(defaultWidth);
    setWidth(defaultWidth);
    storage.setItem(storageKey, String(defaultWidth));
  }, [defaultWidth, storageKey]);

  return {
    width,
    isDragging,
    handleProps: {
      isDragging,
      onPointerDown,
      onDoubleClick: resetWidth,
      style: { touchAction: 'none' },
    } as ResizeHandleProps,
  };
}
