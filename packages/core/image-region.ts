/**
 * Image regions: a comment on part of an image in a markdown document
 * (#2100, approval "image-region-comments", variant C).
 *
 * A comment drawn as a box on an image in the image viewer is stored as ONE
 * additive field on an ordinary COMMENT annotation, `imageRegion`:
 *
 *   { v: 1, src: "figures/status-colors.png", sourceLine: 63,
 *     box: { x: 1820, y: 380, w: 420, h: 160 },
 *     naturalWidth: 3664, naturalHeight: 1453 }
 *
 * - `src` is the image's reference AS WRITTEN in the markdown (never the
 *   `/api/image?path=…` URL the browser loads), so the agent finds it in the
 *   file and opens the same file.
 * - `sourceLine` is the 1-based DOCUMENT line the image is written on, or
 *   null when the writer could not place it.
 * - `box` is in the image's own (natural) pixels, integers, inside the
 *   image: the agent can crop the exact spot whatever zoom the reviewer used.
 *
 * Same contract as `diagram-anchor.ts`: the types here are what
 * `@plannotator/ui/types`'s `Annotation.imageRegion` carries, and
 * `parseImageRegion` is the one fail-closed validator every ingest (the
 * external-annotation POST and PATCH, the feedback archive, the export) runs.
 * Browser-safe, no dependencies.
 */

/** A rectangle in the image's own pixels. */
export interface ImageRegionBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface ImageRegion {
  readonly v: 1;
  /** The image's reference as written in the markdown. */
  readonly src: string;
  /** 1-based document line of the image, or null. */
  readonly sourceLine: number | null;
  readonly box: ImageRegionBox;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

/** Longest `src` the parser keeps (a markdown image reference, persisted). */
export const MAX_IMAGE_REGION_SRC_LENGTH = 2048;

/** Largest image side the parser accepts, in pixels. Generous: a 2× export
 * of a long page is tens of thousands of pixels; nothing real is larger. */
export const MAX_IMAGE_REGION_DIMENSION = 1_000_000;

/** The wire key a host that stores anchors as an opaque JSON blob uses;
 * Plannotator carries the region on the annotation itself under
 * `imageRegion`. */
export const IMAGE_REGION_KEY = 'imageRegion';

const isPositiveInt = (value: unknown, max = MAX_IMAGE_REGION_DIMENSION): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

const isNonNegativeInt = (value: unknown, max = MAX_IMAGE_REGION_DIMENSION): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;

// C0 / C1 controls and line breaks: a src is one token on one line.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * The one fail-closed validator: a fresh, normalized `ImageRegion` (unknown
 * keys dropped), or null for anything malformed — a missing or empty src, a
 * box that is not integers, has no area, or reaches outside the image, an
 * unknown version. `sourceLine` absent reads as null.
 */
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

/** The file name a src names (`status-colors.png` for
 * `figures/status-colors.png?v=2`), else the src itself. */
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

/**
 * The location an export prints under a region comment (the approved
 * prototype's two lines):
 *
 *   Image: figures/status-colors.png (line 63)
 *   Region: x=1820 y=380 w=420 h=160 (of 3664×1453)
 */
export function imageRegionLocationLines(region: ImageRegion): string {
  return `${imageRegionImageLine(region)}\n${imageRegionBoxLine(region)}`;
}

/** Two regions name the same image (the src as written). */
export function sameRegionImage(a: Pick<ImageRegion, 'src'>, b: Pick<ImageRegion, 'src'>): boolean {
  return a.src === b.src;
}
