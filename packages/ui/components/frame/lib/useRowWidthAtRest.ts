import { useCallback, useRef, useState } from "react";

const ROW_WIDTH_REST_MS = 150;

export function useRowWidthAtRest(): {
  rowWidth: number | null;
  observeRow: (element: HTMLDivElement | null) => void;
} {
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const restTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observeRow = useCallback((element: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (restTimerRef.current !== null) {
      clearTimeout(restTimerRef.current);
      restTimerRef.current = null;
    }
    if (element === null || typeof ResizeObserver === "undefined") {
      setRowWidth(null);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined || width <= 0) return;
      if (restTimerRef.current !== null) clearTimeout(restTimerRef.current);
      restTimerRef.current = setTimeout(() => {
        restTimerRef.current = null;
        setRowWidth((previous) => {
          const next = Math.round(width);
          return previous === next ? previous : next;
        });
      }, ROW_WIDTH_REST_MS);
    });
    observer.observe(element);
    observerRef.current = observer;
    const measured = element.getBoundingClientRect().width;
    setRowWidth(measured > 0 ? Math.round(measured) : null);
  }, []);
  return { rowWidth, observeRow };
}
