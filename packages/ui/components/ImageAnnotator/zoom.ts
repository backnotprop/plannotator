/**
 * The drawing screen's zoom on a phone (`ImageAnnotator`'s optional
 * `zoomable`), kept pure so the geometry is tested without a layout engine.
 *
 * The picture is laid out once at its "base" size: the whole picture fitted
 * into the drawing area, never above its own pixels. Strokes are kept in base
 * pixels, as they always were (the export scales them by natural / base). A
 * zoom is a translate plus a scale on that base box, the same viewport the
 * image viewer uses (`imageZoom.ts`), with the base box as the "image": the
 * smallest scale shows the whole picture, and a zoomed picture always covers
 * the area, so it can never be panned out of sight.
 */
import { clampViewport, type ZoomLimits, type ZoomSize, type ZoomViewport } from '../imageZoom';

/** A part of the picture in its own pixels (the viewer's `visibleBox`). */
export interface AnnotatorBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** At most this many times the base size, and at least far enough in that one picture pixel is this many screen pixels. */
export const ANNOTATOR_ZOOM_MIN_MAX = 4;
export const ANNOTATOR_PIXEL_ZOOM = 3;
/** A drawing area this many CSS pixels in from every side when the picture is laid out (room for a stroke to start outside it). */
export const ANNOTATOR_BASE_PAD = 8;

function valid(size: ZoomSize | null | undefined): size is ZoomSize {
  return !!size && size.width > 0 && size.height > 0;
}

/**
 * The base size: the whole picture fitted into the area (less its padding), never above its own pixels. Its width is
 * whole CSS pixels and its height follows the picture's own shape, fractional: the export scales both axes by
 * `naturalWidth / clientWidth` (`clientWidth` an integer), which is then exactly natural / base on each axis; a
 * fractional width, or a height rounded on its own, put a stroke off where it was drawn. Taken once when the screen
 * opens and kept while it is open (`ZoomableCanvas`): strokes are in base pixels, so a base that followed a rotation
 * or a resize would move every stroke already drawn.
 */
export function annotatorBase(natural: ZoomSize, area: ZoomSize, pad = ANNOTATOR_BASE_PAD): ZoomSize {
  if (!valid(natural) || !valid(area)) return { width: 0, height: 0 };
  const room = { width: Math.max(1, area.width - 2 * pad), height: Math.max(1, area.height - 2 * pad) };
  const scale = Math.min(1, room.width / natural.width, room.height / natural.height);
  // Down to a whole pixel (never over the room), the tiny float error of an exact fit not costing one.
  const width = Math.max(1, Math.floor(natural.width * scale + 1e-6));
  return { width, height: (width * natural.height) / natural.width };
}

/**
 * The whole picture (1, or less when the area shrank since the base was taken: a phone turned) to far enough in that
 * a picture pixel is a few screen pixels, never under 4×.
 */
export function annotatorLimits(natural: ZoomSize, base: ZoomSize, area?: ZoomSize | null): ZoomLimits {
  if (!valid(natural) || !valid(base)) return { min: 1, max: ANNOTATOR_ZOOM_MIN_MAX };
  const min = valid(area) ? Math.min(1, area.width / base.width, area.height / base.height) : 1;
  return { min, max: Math.max(ANNOTATOR_ZOOM_MIN_MAX, (ANNOTATOR_PIXEL_ZOOM * natural.width) / base.width) };
}

/** A panorama fitted whole is a sliver: it opens this share of the area tall, from its left. */
export const ANNOTATOR_SLIVER_SHARE = 1 / 3;

/**
 * Where the drawing screen opens: on the part of the picture the viewer
 * showed (`shown`, in the picture's own pixels), filling the area, so what
 * the person was looking at is what they draw on. When the viewer showed all
 * of it (or nothing was given), the whole picture, unless that is a sliver:
 * a panorama opens a third of the area tall from its left, a tall screenshot
 * fills the width from its top, both pinch out to the whole.
 */
export function annotatorInitialView(natural: ZoomSize, base: ZoomSize, area: ZoomSize, shown?: AnnotatorBox | null): ZoomViewport {
  const limits = annotatorLimits(natural, base, area);
  const whole = clampViewport({ x: 0, y: 0, scale: limits.min }, base, area, limits);
  if (!valid(natural) || !valid(base) || !valid(area)) return whole;
  if (shown) {
    const k = base.width / natural.width;
    const w = shown.w * k;
    const h = shown.h * k;
    const scale = w > 0 && h > 0 ? Math.min(area.width / w, area.height / h) : 0;
    // Closer than the whole picture fitted: the shown part's top-left at the area's top-left (a tall picture read from its top, a panorama from its left).
    const wholeFit = Math.min(area.width / base.width, area.height / base.height);
    if (scale > wholeFit * 1.01) return clampViewport({ scale, x: -shown.x * k * scale, y: -shown.y * k * scale }, base, area, limits);
  }
  if (base.height < area.height * ANNOTATOR_SLIVER_SHARE && base.width / base.height > area.width / area.height) {
    const scale = (area.height * ANNOTATOR_SLIVER_SHARE) / base.height;
    return clampViewport({ scale, x: 0, y: (area.height - base.height * scale) / 2 }, base, area, limits);
  }
  if (base.width * 2 < area.width && base.height / base.width > area.height / area.width) {
    return clampViewport({ scale: area.width / base.width, x: 0, y: 0 }, base, area, limits);
  }
  return whole;
}

/** A point on the drawing area (CSS pixels from its top-left) in base pixels: where a stroke lands at this zoom and pan. */
export function annotatorPoint(view: ZoomViewport, ax: number, ay: number): { x: number; y: number } {
  return { x: (ax - view.x) / view.scale, y: (ay - view.y) / view.scale };
}

/** Whether an area point is on the picture at this view. */
export function annotatorOnPicture(view: ZoomViewport, base: ZoomSize, ax: number, ay: number): boolean {
  const p = annotatorPoint(view, ax, ay);
  return p.x >= 0 && p.y >= 0 && p.x <= base.width && p.y <= base.height;
}

/** The largest side, in device pixels, the drawing's canvas is given (a zoomed canvas is redrawn sharp up to this). */
export const ANNOTATOR_CANVAS_MAX_SIDE = 4096;

/** How many canvas pixels to a base pixel at this zoom: sharp on screen, within the cap. */
export function annotatorCanvasRatio(base: ZoomSize, scale: number, devicePixelRatio: number): number {
  if (!valid(base)) return 1;
  const wanted = Math.max(1, scale * Math.max(1, devicePixelRatio));
  return Math.min(wanted, ANNOTATOR_CANVAS_MAX_SIDE / Math.max(base.width, base.height));
}
