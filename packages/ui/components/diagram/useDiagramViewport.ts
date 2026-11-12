import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenRect } from '../../utils/diagram-projection';
import { DOUBLE_TAP_ZOOM } from '../imageZoom';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;
export const WHEEL_ZOOM_SENSITIVITY = 0.002;
export const DRAG_THRESHOLD_PX = 4;
export const TOUCH_DRAG_THRESHOLD_PX = 10;
export const FIT_PADDING_PX = 24;

export interface Viewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface ContentSize {
  readonly width: number;
  readonly height: number;
}

const IDENTITY: Viewport = { x: 0, y: 0, scale: 1 };

function clampScale(scale: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

export function useDiagramViewport(
  hostRef: RefObject<HTMLElement | null>,
  content: ContentSize | null,
): {
  readonly viewport: Viewport;
  readonly fit: () => void;
  readonly zoomBy: (factor: number, clientX?: number, clientY?: number) => void;
  readonly toggleZoom: (clientX: number, clientY: number) => void;
  readonly panBy: (dx: number, dy: number) => void;
  readonly panIntoView: (rect: ScreenRect) => void;
} {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const contentRef = useRef(content);
  contentRef.current = content;
  const adjustedRef = useRef(false);

  const fit = useCallback(() => {
    const host = hostRef.current;
    const size = contentRef.current;
    if (host === null || size === null || size.width <= 0 || size.height <= 0) {
      setViewport(IDENTITY);
      return;
    }
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      setViewport(IDENTITY);
      return;
    }
    const availableWidth = Math.max(1, rect.width - FIT_PADDING_PX * 2);
    const availableHeight = Math.max(1, rect.height - FIT_PADDING_PX * 2);
    const scale = clampScale(Math.min(availableWidth / size.width, availableHeight / size.height));
    adjustedRef.current = false;
    setViewport({
      x: (rect.width - size.width * scale) / 2,
      y: (rect.height - size.height * scale) / 2,
      scale,
    });
  }, [hostRef]);

  useEffect(() => {
    if (!adjustedRef.current) fit();
    const host = hostRef.current;
    if (host === null || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!adjustedRef.current) fit();
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [fit, hostRef, content]);

  const zoomBy = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const host = hostRef.current;
      adjustedRef.current = true;
      setViewport((current) => {
        const scale = clampScale(current.scale * factor);
        if (scale === current.scale) return current;
        const rect = host?.getBoundingClientRect();
        const px = clientX !== undefined && rect ? clientX - rect.left : (rect?.width ?? 0) / 2;
        const py = clientY !== undefined && rect ? clientY - rect.top : (rect?.height ?? 0) / 2;
        const ratio = scale / current.scale;
        return {
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
          scale,
        };
      });
    },
    [hostRef],
  );

  const toggleZoom = useCallback(
    (clientX: number, clientY: number) => {
      if (adjustedRef.current) fit();
      else zoomBy(DOUBLE_TAP_ZOOM, clientX, clientY);
    },
    [fit, zoomBy],
  );

  const panBy = useCallback((dx: number, dy: number) => {
    adjustedRef.current = true;
    setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }, []);

  const panIntoView = useCallback(
    (target: ScreenRect) => {
      const host = hostRef.current;
      if (host === null) return;
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const inside =
        target.left >= 0 &&
        target.top >= 0 &&
        target.left + target.width <= rect.width &&
        target.top + target.height <= rect.height;
      if (inside) return;
      const dx = rect.width / 2 - (target.left + target.width / 2);
      const dy = rect.height / 2 - (target.top + target.height / 2);
      setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    },
    [hostRef],
  );

  return { viewport, fit, zoomBy, toggleZoom, panBy, panIntoView };
}
