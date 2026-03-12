import { useState, useRef, useCallback, useEffect } from 'react';
import { storage } from '../utils/storage';

interface UseResizablePanelOptions {
  storageKey: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  side?: 'left' | 'right';
}

export interface ResizeHandleProps {
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
  onTouchStart: (e: React.TouchEvent) => void;
  onDoubleClick: () => void;
}

export function useResizablePanel({
  storageKey,
  defaultWidth = 288,
  minWidth = 200,
  maxWidth = 600,
  side = 'right',
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
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(width);

  const updateWidth = useCallback((value: number) => {
    widthRef.current = value;
    setWidth(value);
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startXRef.current = e.clientX;
    startWidthRef.current = widthRef.current;
    setIsDragging(true);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    startXRef.current = e.touches[0].clientX;
    startWidthRef.current = widthRef.current;
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const getClientX = (e: MouseEvent | TouchEvent): number => {
      if ('touches' in e) return e.touches[0]?.clientX ?? (e as TouchEvent).changedTouches[0]?.clientX ?? 0;
      return (e as MouseEvent).clientX;
    };

    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = getClientX(e);
      const delta = side === 'right'
        ? startXRef.current - clientX
        : clientX - startXRef.current;
      updateWidth(Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta)));
    };

    const onUp = () => {
      setIsDragging(false);
      storage.setItem(storageKey, String(widthRef.current));
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onUp);
    document.addEventListener('touchcancel', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('touchcancel', onUp);
    };
  }, [isDragging, minWidth, maxWidth, storageKey, side, updateWidth]);

  const resetWidth = useCallback(() => {
    updateWidth(defaultWidth);
    storage.setItem(storageKey, String(defaultWidth));
  }, [defaultWidth, storageKey, updateWidth]);

  return {
    width,
    isDragging,
    handleProps: {
      isDragging,
      onMouseDown: handleMouseDown,
      onTouchStart: handleTouchStart,
      onDoubleClick: resetWidth,
    } as ResizeHandleProps,
  };
}
