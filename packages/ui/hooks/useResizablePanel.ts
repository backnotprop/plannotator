import { useState, useRef, useCallback } from 'react';
import { storage } from '../utils/storage';

interface UseResizablePanelOptions {
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right' | 'top' | 'bottom';
  axis?: 'x' | 'y';
  onSnapClose?: () => void;
  snapCloseRatio?: number;
  apply?: (width: number) => void;
  onClick?: () => void;
  clickThreshold?: number;
}

export interface ResizeHandleProps {
  isDragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  style: React.CSSProperties;
}

export function useResizablePanel({
  storageKey,
  defaultWidth = 288,
  minWidth = 200,
  maxWidth = 600,
  side = 'right',
  axis = 'x',
  onSnapClose,
  snapCloseRatio = 0.6,
  apply,
  onClick,
  clickThreshold = 4,
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

  const widthRef = useRef(width);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const draggingRef = useRef(false);
  const snappedRef = useRef(false);
  const movedRef = useRef(false);
  const latestXRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const applyRef = useRef(apply);
  applyRef.current = apply;
  const onSnapCloseRef = useRef(onSnapClose);
  onSnapCloseRef.current = onSnapClose;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  const flush = useCallback(() => {
    rafRef.current = null;
    if (!draggingRef.current) return;
    const delta =
      side === 'right' || side === 'bottom'
        ? startXRef.current - latestXRef.current
        : latestXRef.current - startXRef.current;
    const raw = startWidthRef.current + delta;

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
      if (e.button !== 0) return;
      e.preventDefault();
      const pos = axis === 'y' ? e.clientY : e.clientX;
      startXRef.current = pos;
      startWidthRef.current = widthRef.current;
      latestXRef.current = pos;
      snappedRef.current = false;
      movedRef.current = false;
      draggingRef.current = true;
      setIsDragging(true);

      const onMove = (ev: PointerEvent) => {
        if (!draggingRef.current) return;
        latestXRef.current = axis === 'y' ? ev.clientY : ev.clientX;
        if (Math.abs(latestXRef.current - startXRef.current) > clickThreshold)
          movedRef.current = true;
        if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
      };
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
      };
      function onUp(e: PointerEvent) {
        const cancelled = e?.type === 'pointercancel';
        const wasSnapped = snappedRef.current;
        draggingRef.current = false;
        snappedRef.current = false;
        if (rafRef.current != null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        setIsDragging(false);
        if (!wasSnapped) {
          if (onClickRef.current && !movedRef.current && !cancelled) {
            onClickRef.current();
          } else {
            setWidth(widthRef.current);
            storage.setItem(storageKey, String(widthRef.current));
          }
        }
        cleanup();
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [flush, storageKey, axis, clickThreshold],
  );

  const resetWidth = useCallback(() => {
    widthRef.current = defaultWidth;
    applyRef.current?.(defaultWidth);
    setWidth(defaultWidth);
    storage.setItem(storageKey, String(defaultWidth));
  }, [defaultWidth, storageKey]);

  return {
    width,
    size: width,
    isDragging,
    handleProps: {
      isDragging,
      onPointerDown,
      onDoubleClick: resetWidth,
      style: { touchAction: 'none' },
    } as ResizeHandleProps,
  };
}
