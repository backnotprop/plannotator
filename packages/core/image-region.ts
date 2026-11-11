/** A rectangle in the image's own pixels. */
export interface ImageRegionBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ImageRegion {
  readonly v: 1;
  readonly src: string;
  readonly sourceLine: number | null;
  readonly box: ImageRegionBox;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** Longest `src` the parser keeps (a markdown image reference, persisted). */
export const MAX_IMAGE_REGION_SRC_LENGTH = 2048;

/** Largest image side the parser accepts, in pixels. */
export const MAX_IMAGE_REGION_DIMENSION = 1_000_000;

/**
 * The wire key a host that stores anchors as an opaque JSON blob uses; Plannotator carries the
 * region on the annotation itself under `imageRegion`.
 */
export const IMAGE_REGION_KEY = 'imageRegion';

const isPositiveInt = (value: unknown, max = MAX_IMAGE_REGION_DIMENSION): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

const isNonNegativeInt = (value: unknown, max = MAX_IMAGE_REGION_DIMENSION): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function parseImageRegion(value: unknown): ImageRegion | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1) return null;
  const src = v.src;
  if (typeof src !== 'string' || src.trim() === '' || src.length > MAX_IMAGE_REGION_SRC_LENGTH || CONTROL.test(src)) {
    return null;
  }
  let sourceLine: number | null = null;
  if (v.sourceLine !== undefined && v.sourceLine !== null) {
    if (!isPositiveInt(v.sourceLine, Number.MAX_SAFE_INTEGER)) return null;
    sourceLine = v.sourceLine;
  }
  const { naturalWidth, naturalHeight } = v;
  if (!isPositiveInt(naturalWidth) || !isPositiveInt(naturalHeight)) return null;
  const box = v.box;
  if (box === null || typeof box !== 'object' || Array.isArray(box)) return null;
  const { x, y, w, h } = box as Record<string, unknown>;
  if (!isNonNegativeInt(x) || !isNonNegativeInt(y) || !isPositiveInt(w) || !isPositiveInt(h)) return null;
  if (x + w > naturalWidth || y + h > naturalHeight) return null;
  return { v: 1, src, sourceLine, box: { x, y, w, h }, naturalWidth, naturalHeight };
}

/**
 * The file name a src names (`status-colors.png` for `figures/status-colors.png?v=2`), else the src
 * itself.
 */
export function imageRegionFileName(src: string): string {
  const path = src.split(/[?#]/)[0] ?? src;
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  if (!last) return src;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** `420 × 160 px`: the box's size in the image's own pixels. */
export function imageRegionSize(region: Pick<ImageRegion, 'box'>): string {
  return `${region.box.w} × ${region.box.h} px`;
}

/** `Region: x=1820 y=380 w=420 h=160 (of 3664×1453)`. */
export function imageRegionBoxLine(region: ImageRegion): string {
  const { x, y, w, h } = region.box;
  return `Region: x=${x} y=${y} w=${w} h=${h} (of ${region.naturalWidth}×${region.naturalHeight})`;
}

/** `Image: figures/status-colors.png (line 63)`; no line part when unknown. */
export function imageRegionImageLine(region: ImageRegion): string {
  return `Image: ${region.src}${region.sourceLine !== null ? ` (line ${region.sourceLine})` : ''}`;
}

export function imageRegionLocationLines(region: ImageRegion): string {
  return `${imageRegionImageLine(region)}\n${imageRegionBoxLine(region)}`;
}

/** Two regions name the same image (the src as written). */
export function sameRegionImage(a: Pick<ImageRegion, 'src'>, b: Pick<ImageRegion, 'src'>): boolean {
  return a.src === b.src;
}
