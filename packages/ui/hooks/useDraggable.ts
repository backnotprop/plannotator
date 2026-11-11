import { useState, useRef, useCallback, useEffect } from 'react';

const DRAG_THRESHOLD = 3;
const VISIBLE_MIN = 50;

interface DragPosition {
  top: number;
  left: number;
}

/**
 * Makes a fixed-position element draggable by its header/handle.
 * Reads the element's actual rendered position on drag start via getBoundingClientRect,
 * so it works regardless of CSS transforms (flipAbove, translateX, etc.).
 *
 * @param elementRef - Ref to the positioned element (the popover/toolbar container)
 * @param options.keepInside - Opt-in: the whole element stays inside the window (an element larger than the window
 *   keeps its top left corner in). Absent: at least 50 px of it stays on screen, as before.
 */
export function useDraggable(elementRef: React.RefObject<HTMLElement | null>, options: { keepInside?: boolean } = {}) {
  const keepInside = options.keepInside ?? false;
  const [dragPosition, setDragPosition] = useState<DragPosition | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [wasDragged, setWasDragged] = useState(false);

  const startPointerRef = useRef({ x: 0, y: 0 });
  const startElRef = useRef({ top: 0, left: 0 });
  const thresholdMetRef = useRef(false);

  const reset = useCallback(() => {
    setDragPosition(null);
    setIsDragging(false);
    setWasDragged(false);
  }, []);

  // Document-level pointermove/pointerup while dragging
  useEffect(() => {
    if (!isDragging) return;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startPointerRef.current.x;
      const dy = e.clientY - startPointerRef.current.y;

      if (!thresholdMetRef.current) {
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
        thresholdMetRef.current = true;
      }

      if (keepInside) {
        const height = elementRef.current?.offsetHeight ?? 0;
        const width = elementRef.current?.offsetWidth ?? 0;
        setDragPosition({
          top: Math.max(0, Math.min(startElRef.current.top + dy, window.innerHeight - height)),
          left: Math.max(0, Math.min(startElRef.current.left + dx, window.innerWidth - width)),
        });
        return;
      }

      // Clamp to keep at least VISIBLE_MIN px visible on screen
      const top = Math.max(
        -((elementRef.current?.offsetHeight ?? 0) - VISIBLE_MIN),
        Math.min(startElRef.current.top + dy, window.innerHeight - VISIBLE_MIN),
      );
      const left = Math.max(
        -((elementRef.current?.offsetWidth ?? 0) - VISIBLE_MIN),
        Math.min(startElRef.current.left + dx, window.innerWidth - VISIBLE_MIN),
      );

      setDragPosition({ top, left });
    };

    const onUp = () => {
      setIsDragging(false);
      if (thresholdMetRef.current) {
        setWasDragged(true);
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
  }, [isDragging, elementRef, keepInside]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only primary button (left click / single touch)
      if (e.button !== 0) return;
      // Don't drag if clicking on an interactive element inside the handle
      const target = e.target as HTMLElement;
      if (target.closest('button, a, input, textarea, select')) return;

      const el = elementRef.current;
      if (!el) return;

      const rect = el.getBoundingClientRect();
      startPointerRef.current = { x: e.clientX, y: e.clientY };
      startElRef.current = { top: rect.top, left: rect.left };
      thresholdMetRef.current = false;
      setIsDragging(true);
    },
    [elementRef],
  );

  return {
    dragPosition,
    isDragging,
    wasDragged,
    reset,
    dragHandleProps: {
      onPointerDown,
      style: {
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none' as const,
        touchAction: 'none' as const,
      },
    },
  };
}
