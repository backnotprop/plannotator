/** The image lightbox's zoom math, kept pure so it can be tested without a layout engine. */

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

/** Rows of a stage that things float over: Fit and the pan's limits work in the stage between them. */
export interface ZoomClear {
  readonly top: number;
  readonly bottom: number;
}

/** 800%: an image pixel is then 8 screen pixels, enough to read any screenshot. */
export const LIGHTBOX_ZOOM_MAX = 8;
/**
 * Wheel zoom: factor = exp(-deltaY * sensitivity), with deltaY capped so a mouse notch (100 px)
 * is about 1.28x, close to the diagram canvas's step.
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.01;
export const WHEEL_ZOOM_DELTA_CAP = 25;
/**
 * A plain-wheel gesture keeps the meaning it started with (zoom or scroll) until the wheel rests
 * this long.
 */
export const WHEEL_LATCH_MS = 250;
/** A press that travels less than this is a tap (a click), not a pan. */
export const TAP_SLOP_MOUSE_PX = 4;
export const TAP_SLOP_TOUCH_PX = 10;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** A double click at Fit zooms to twice the Fit scale. */
export const DOUBLE_TAP_ZOOM = 2;

/** The smallest scale is always `contain`, so a reader can zoom out to the whole image from either. */
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

/** Whether two viewports are the same on screen (a half pixel, a thousandth of scale): a picture still resting where Fit put it. */
export function sameViewport(a: ZoomViewport, b: ZoomViewport): boolean {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.scale - b.scale) < 0.001;
}

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
 * Whether the part of an image on screen (`visibleBox`, its own pixels) can still pan sideways:
 * `1` shows more of its right (the finger moving left), `-1` more of its left.
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
 * A wheel event's travel in CSS pixels. Lines (Firefox's mouse wheel) count 16 px and pages the
 * stage's height.
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

export function wheelZoomFactor(dy: number): number {
  return Math.exp(-clampNumber(dy, -WHEEL_ZOOM_DELTA_CAP, WHEEL_ZOOM_DELTA_CAP) * WHEEL_ZOOM_SENSITIVITY);
}

/** A rectangle in the image's own pixels (integers once made by `naturalBoxFromPoints`). */
export interface NaturalBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface StageRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function stageToNatural(view: ZoomViewport, px: number, py: number): { x: number; y: number } {
  return { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
}

/**
 * The box two stage points span (a drag's start and end, in either direction), in the image's
 * own pixels: clamped to the image.
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

export function naturalBoxToStage(view: ZoomViewport, box: NaturalBox): StageRect {
  return { left: view.x + box.x * view.scale, top: view.y + box.y * view.scale, width: box.w * view.scale, height: box.h * view.scale };
}

/**
 * The part of the image the stage shows now, in the image's own pixels: what Enter comments on
 * in Region mode (the keyboard's way to a box.
 */
export function visibleNaturalBox(view: ZoomViewport, image: ZoomSize, stage: ZoomSize): NaturalBox | null {
  return naturalBoxFromPoints(view, { x: 0, y: 0 }, { x: stage.width, y: stage.height }, image);
}

export const ZOOM_TO_BOX_SHARE = 0.5;

/** The viewport that shows a box large and centred: it fills `share` of the stage on its tighter axis. */
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
