import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ScreenRect } from '../../utils/diagram-projection';
import { DOUBLE_TAP_ZOOM } from '../imageZoom';

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
/** The same threshold for a finger, which wobbles more than a mouse: a tap
 * that drifts a few pixels must still be a tap. */
export const TOUCH_DRAG_THRESHOLD_PX = 10;
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

/** The zoom strip over the host, from its measured rect: its left and right
 * edges from the host's left, and `height`, from its top to the host's
 * bottom (the strip's height plus its margin). */
export interface ControlsBand {
  readonly left: number;
  readonly right: number;
  readonly height: number;
}

/** Room an inline host adds to the bottom of its box so the zoom strip never
 * covers the drawing at rest. `px`: what the host has added (0 at first).
 * `onChange`: asks the host for another amount. */
export interface ControlsReserve {
  readonly px: number;
  readonly onChange: (px: number) => void;
}

/**
 * Fit `content` in a host of size `host` (its box without any reserve). With
 * `controls`, a fitted drawing that would reach the strip gets room under it:
 * `reserve` is how much the box grows (at most the strip's band, and only as
 * far as the drawing needs), and the drawing, at the same scale, is centred
 * in the area above the strip. A drawing clear of the strip is placed as
 * without `controls`, with no reserve.
 */
export function fitInHost(
  host: ContentSize,
  content: ContentSize,
  fitMaxScale: number,
  controls: ControlsBand | null,
): { readonly viewport: Viewport; readonly reserve: number } {
  const availableWidth = Math.max(1, host.width - FIT_PADDING_PX * 2);
  const availableHeight = Math.max(1, host.height - FIT_PADDING_PX * 2);
  const scale = clampScale(Math.min(fitMaxScale, availableWidth / content.width, availableHeight / content.height));
  const width = content.width * scale;
  const height = content.height * scale;
  const x = (host.width - width) / 2;
  const y = (host.height - height) / 2;
  const reaches =
    controls !== null && x < controls.right && x + width > controls.left && y + height > host.height - controls.height;
  if (!reaches) return { viewport: { x, y, scale }, reserve: 0 };
  // Whole pixels, so a box grown by it measures the same next time (no resize after resize).
  const reserve = Math.ceil(Math.min(controls.height, Math.max(0, height + FIT_PADDING_PX * 2 + controls.height - host.height)));
  const above = host.height + reserve - controls.height;
  return { viewport: { x, y: (above - height) / 2, scale }, reserve };
}

export function useDiagramViewport(
  hostRef: RefObject<HTMLElement | null>,
  content: ContentSize | null,
  /** The largest scale Fit may choose (zoom keeps the full range). Default: no limit below `ZOOM_MAX`. */
  fitMaxScale: number = ZOOM_MAX,
  /** Opt-in: keep the drawing clear of this strip at rest by growing the host's box (`fitInHost`). */
  keepClear?: { readonly stripRef: RefObject<HTMLElement | null>; readonly reserve: ControlsReserve },
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
  const fitMaxRef = useRef(fitMaxScale);
  fitMaxRef.current = fitMaxScale;
  const keepClearRef = useRef(keepClear);
  keepClearRef.current = keepClear;
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
    const keep = keepClearRef.current;
    const strip = keep?.stripRef.current?.getBoundingClientRect();
    const controls =
      keep !== undefined && strip !== undefined && strip.width > 0 && strip.height > 0
        ? { left: strip.left - rect.left, right: strip.right - rect.left, height: rect.bottom - strip.top }
        : null;
    // The box as the host sized it: the reserve it added for the strip is taken off again, so the reserve is decided
    // the same way every time (a box grown for the strip does not then find the strip clear and shrink back).
    const applied = keep?.reserve.px ?? 0;
    const { viewport: next, reserve } = fitInHost(
      { width: rect.width, height: Math.max(1, rect.height - applied) },
      size,
      fitMaxRef.current,
      controls,
    );
    adjustedRef.current = false;
    setViewport(next);
    if (keep !== undefined && reserve !== applied) keep.reserve.onChange(reserve);
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
  }, [fit, hostRef, content, fitMaxScale]);

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

  // A double tap: from Fit it zooms in about the finger (the image viewer's
  // step, twice the Fit scale); from any zoom or pan it goes back to Fit.
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
