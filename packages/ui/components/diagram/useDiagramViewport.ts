import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenRect } from '../../utils/diagram-projection';

/**
 * The canvas viewport: a translate plus a scale on the wrapper around the
 * rendered svg (zoom, pan and fit are the primary interaction). Every
 * constant below is a design constant with its reason, never a cap on what
 * a person may do with the diagram.
 */

/** Zoom range. Below 0.1 a 1000px diagram is a 100px smudge and the rings
 * collapse onto each other; above 8 a node label is a screenful. The
 * range keeps the render legible and the transform finite. */
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** One key press or one corner-control click. 1.25 needs four presses to
 * double, which is fine-grained enough to land on a node. */
export const ZOOM_STEP = 1.25;
/** Wheel zoom: factor = exp(-deltaY * sensitivity). One 100px notch is
 * about 1.22x, close to ZOOM_STEP so keys and wheel feel the same. */
export const WHEEL_ZOOM_SENSITIVITY = 0.002;
/** The distance a pointer must travel before a press becomes a pan. Under
 * it, releasing is a click on the part beneath (the pinpoint). */
export const DRAG_THRESHOLD_PX = 4;
/** Fit leaves this much air on every side of the host so the outermost
 * node and its ring never touch the edge; the badge (a 20px disc at the
 * node's top-right corner) stays inside it. */
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
  readonly panBy: (dx: number, dy: number) => void;
  readonly panIntoView: (rect: ScreenRect) => void;
} {
  const [viewport, setViewport] = useState<Viewport>(IDENTITY);
  const contentRef = useRef(content);
  contentRef.current = content;
  // Whether the person zoomed or panned since the last fit. While true, a
  // new render (the draft preview) or a host resize (the Source pane
  // opening, the window) keeps their view; a fit (the key, the control, a
  // first arrival) clears it.
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
      // No layout (a hidden tab, happy-dom): identity until a size arrives.
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

  // Fit on arrival and on every new content size (a first render, a
  // re-render with a different bounding box) and on host resize (the
  // Source pane opening, the window), unless the person has zoomed or
  // panned since the last fit: then their view stands until they fit again.
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
        // Zoom about the pointer when given, else the host's center, so
        // the part under the cursor stays under the cursor.
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

  return { viewport, fit, zoomBy, panBy, panIntoView };
}
