/**
 * The image lightbox's zoom math, kept pure so it can be tested without a
 * layout engine. A viewport is a translate plus a scale on the image, where
 * scale 1 is the image's own pixels (Actual size) and the translate is the
 * image's top-left corner inside the stage, in CSS pixels.
 *
 * The rules: the smallest scale is Fit (never above 1, so a small image is
 * not blown up), the largest is 8 (800%); an axis on which the image is
 * smaller than the stage is centred, and an axis on which it is larger is
 * kept covering the stage, so the image can never be panned out of sight.
 */

export interface ZoomSize {
  readonly width: number;
  readonly height: number;
}

export interface ZoomViewport {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface ZoomLimits {
  readonly min: number;
  readonly max: number;
}

/** The share of the stage Fit may fill on each axis (1 = edge to edge). */
export interface ZoomInset {
  readonly x: number;
  readonly y: number;
}

/** 800%: an image pixel is then 8 screen pixels, enough to read any screenshot. */
export const LIGHTBOX_ZOOM_MAX = 8;
/** Wheel zoom: factor = exp(-deltaY * sensitivity), with deltaY capped so a
 * mouse notch (100 px) is about 1.28x, close to the diagram canvas's step,
 * while a trackpad pinch (a few px per event) stays smooth. */
export const WHEEL_ZOOM_SENSITIVITY = 0.01;
export const WHEEL_ZOOM_DELTA_CAP = 25;
/** A plain-wheel gesture keeps the meaning it started with (zoom or scroll)
 * until the wheel rests this long, so wheeling in past the screen's edge
 * does not flip from zooming to scrolling halfway through. */
export const WHEEL_LATCH_MS = 250;
/** A press that travels less than this is a tap (a click), not a pan. */
export const TAP_SLOP_MOUSE_PX = 4;
export const TAP_SLOP_TOUCH_PX = 10;
/** Two taps this close in time and space are a double tap (or double click). */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** A double click at Fit zooms to twice the Fit scale. */
export const DOUBLE_TAP_ZOOM = 2;

/**
 * Which way Fit fits: the whole image (`contain`, the default), or its width
 * (a tall screenshot read from the top) or height (a panorama read from the
 * left). The smallest scale is always `contain`, so a reader can zoom out to
 * the whole image from either.
 */
export type FitAxis = 'contain' | 'width' | 'height';

const FULL: ZoomInset = { x: 1, y: 1 };

function valid(size: ZoomSize | null | undefined): size is ZoomSize {
  return !!size && size.width > 0 && size.height > 0;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The scale at which the whole image (or its width, or its height) fits the stage, never above 1. */
export function fitScale(image: ZoomSize, stage: ZoomSize, inset: ZoomInset = FULL, axis: FitAxis = 'contain'): number {
  if (!valid(image) || !valid(stage)) return 1;
  const across = (stage.width * inset.x) / image.width;
  const down = (stage.height * inset.y) / image.height;
  if (axis === 'width') return Math.min(1, across);
  if (axis === 'height') return Math.min(1, down);
  return Math.min(1, across, down);
}

export function zoomLimits(image: ZoomSize, stage: ZoomSize, inset: ZoomInset = FULL): ZoomLimits {
  const min = fitScale(image, stage, inset);
  return { min, max: Math.max(min, LIGHTBOX_ZOOM_MAX) };
}

function placeAxis(position: number, content: number, room: number): number {
  if (content <= room) return (room - content) / 2;
  return clampNumber(position, room - content, 0);
}

/** The scale within the limits, and the image centred or covering the stage on each axis. */
export function clampViewport(view: ZoomViewport, image: ZoomSize, stage: ZoomSize, limits: ZoomLimits): ZoomViewport {
  const scale = clampNumber(view.scale, limits.min, limits.max);
  return {
    scale,
    x: placeAxis(view.x, image.width * scale, stage.width),
    y: placeAxis(view.y, image.height * scale, stage.height),
  };
}

/** Fit: the whole image, centred (or its width from the top, or its height from the left). */
export function fitViewport(image: ZoomSize, stage: ZoomSize, inset: ZoomInset = FULL, axis: FitAxis = 'contain'): ZoomViewport {
  const limits = zoomLimits(image, stage, inset);
  return clampViewport({ x: 0, y: 0, scale: fitScale(image, stage, inset, axis) }, image, stage, limits);
}

/**
 * Actual size: the image's own pixels. An axis on which it is larger than the
 * stage starts at its top or left edge (a tall screenshot is read from the
 * top); an axis on which it is smaller is centred.
 */
export function actualViewport(image: ZoomSize, stage: ZoomSize, inset: ZoomInset = FULL): ZoomViewport {
  const limits = zoomLimits(image, stage, inset);
  return clampViewport({ x: 0, y: 0, scale: 1 }, image, stage, limits);
}

/** Zoom by `factor` about a point of the stage, so the pixel under it stays under it. */
export function zoomAt(
  view: ZoomViewport,
  factor: number,
  px: number,
  py: number,
  image: ZoomSize,
  stage: ZoomSize,
  limits: ZoomLimits,
): ZoomViewport {
  const scale = clampNumber(view.scale * factor, limits.min, limits.max);
  const ratio = scale / view.scale;
  return clampViewport({ x: px - (px - view.x) * ratio, y: py - (py - view.y) * ratio, scale }, image, stage, limits);
}

/** Move the image by a pointer's travel (or a scroll's, negated by the caller). */
export function panBy(view: ZoomViewport, dx: number, dy: number, image: ZoomSize, stage: ZoomSize, limits: ZoomLimits): ZoomViewport {
  return clampViewport({ x: view.x + dx, y: view.y + dy, scale: view.scale }, image, stage, limits);
}

/** Whether the image is larger than the stage on either axis (so there is something to pan). */
export function overflows(view: ZoomViewport, image: ZoomSize, stage: ZoomSize): boolean {
  return image.width * view.scale > stage.width + 0.5 || image.height * view.scale > stage.height + 0.5;
}

/** Whether a viewport is at the Fit scale (`limits.min`, or a given Fit scale). */
export function atFit(view: ZoomViewport, limits: ZoomLimits | number): boolean {
  const fit = typeof limits === 'number' ? limits : limits.min;
  return Math.abs(view.scale - fit) < 1e-3;
}

/**
 * Whether the part of an image on screen (`visibleBox`, its own pixels) can
 * still pan sideways: `1` shows more of its right (the finger moving left),
 * `-1` more of its left. A swipe that way pans first, and steps once the
 * image is at its edge (approval "inbox-image-swipe").
 */
export function canPanToward(box: Pick<NaturalBox, 'x' | 'w'> | null, naturalWidth: number, dir: 1 | -1): boolean {
  if (!box || !(naturalWidth > 0)) return false;
  return dir > 0 ? box.x + box.w < naturalWidth - 1 : box.x > 1;
}

/** The share of a stage that leaves `padding` CSS pixels on every side (at least a tenth). */
export function paddingInset(stage: ZoomSize, padding: number): ZoomInset {
  if (!valid(stage) || padding <= 0) return FULL;
  return { x: Math.max(0.1, (stage.width - 2 * padding) / stage.width), y: Math.max(0.1, (stage.height - 2 * padding) / stage.height) };
}

/**
 * A wheel event's travel in CSS pixels. Lines (Firefox's mouse wheel) count
 * 16 px and pages the stage's height. Shift turns a vertical wheel sideways,
 * as it does on a page (macOS already reports it as deltaX).
 */
export function wheelTravel(
  event: { deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean },
  pageHeight: number,
): { dx: number; dy: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  let dx = event.deltaX * unit;
  let dy = event.deltaY * unit;
  if (event.shiftKey && dx === 0) {
    dx = dy;
    dy = 0;
  }
  return { dx, dy };
}

/** The zoom factor for a wheel's vertical travel: up (negative) zooms in. */
export function wheelZoomFactor(dy: number): number {
  return Math.exp(-clampNumber(dy, -WHEEL_ZOOM_DELTA_CAP, WHEEL_ZOOM_DELTA_CAP) * WHEEL_ZOOM_SENSITIVITY);
}

// ---------------------------------------------------------------------------
// Region boxes (#2100): a box drawn on the image is kept in the image's own
// (natural) pixels, so it is the same box at every zoom and pan, and the
// agent can crop exactly that spot. These convert between the stage (CSS
// pixels, relative to the stage's top-left) and the image.
// ---------------------------------------------------------------------------

/** A rectangle in the image's own pixels (integers once made by `naturalBoxFromPoints`). */
export interface NaturalBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A rectangle in stage pixels. */
export interface StageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A stage point (CSS pixels from the stage's top-left) in the image's own pixels. Not clamped. */
export function stageToNatural(view: ZoomViewport, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
}

/**
 * The box two stage points span (a drag's start and end, in either
 * direction), in the image's own pixels: clamped to the image, widened to
 * whole pixels (floor the near edges, ceil the far ones), so the box always
 * covers what the reviewer drew. Null when nothing of it is on the image.
 */
export function naturalBoxFromPoints(
  view: ZoomViewport,
  a: { x: number; y: number },
  b: { x: number; y: number },
  image: ZoomSize,
): NaturalBox | null {
  const p = stageToNatural(view, a.x, a.y);
  const q = stageToNatural(view, b.x, b.y);
  const x0 = clampNumber(Math.floor(Math.min(p.x, q.x)), 0, image.width);
  const y0 = clampNumber(Math.floor(Math.min(p.y, q.y)), 0, image.height);
  const x1 = clampNumber(Math.ceil(Math.max(p.x, q.x)), 0, image.width);
  const y1 = clampNumber(Math.ceil(Math.max(p.y, q.y)), 0, image.height);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Where a natural-pixel box is on the stage at a viewport. */
export function naturalBoxToStage(view: ZoomViewport, box: NaturalBox): StageRect {
  return { left: view.x + box.x * view.scale, top: view.y + box.y * view.scale, width: box.w * view.scale, height: box.h * view.scale };
}

/**
 * The part of the image the stage shows now, in the image's own pixels:
 * what Enter comments on in Region mode (the keyboard's way to a box: frame
 * the spot with Actual size and the scroll keys, then press Enter). Null when
 * nothing of the image is on the stage.
 */
export function visibleNaturalBox(view: ZoomViewport, image: ZoomSize, stage: ZoomSize): NaturalBox | null {
  return naturalBoxFromPoints(view, { x: 0, y: 0 }, { x: stage.width, y: stage.height }, image);
}

/** The share of the stage a box fills when the viewer zooms to it. */
export const ZOOM_TO_BOX_SHARE = 0.5;

/**
 * The viewport that shows a box large and centred: it fills `share` of the
 * stage on its tighter axis, within the zoom limits (a box larger than that
 * share at Fit stays at Fit), then the usual clamp keeps the image covering
 * the stage, so a box at an edge sits as near the centre as the image allows.
 */
export function viewportForBox(
  box: NaturalBox,
  image: ZoomSize,
  stage: ZoomSize,
  limits: ZoomLimits,
  share = ZOOM_TO_BOX_SHARE,
): ZoomViewport {
  const scale = clampNumber(Math.min((stage.width * share) / Math.max(1, box.w), (stage.height * share) / Math.max(1, box.h)), limits.min, limits.max);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return clampViewport({ scale, x: stage.width / 2 - cx * scale, y: stage.height / 2 - cy * scale }, image, stage, limits);
}
