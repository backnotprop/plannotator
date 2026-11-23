import type { DiffFileStatus } from '../../types';
import type { ReviewImageSide } from '../../utils/reviewImage';
import {
  ALL_FILES_IMAGE_MAX_HEIGHT,
  LABELS_OVER_MIN_HEIGHT,
  LABELS_OVER_MIN_WIDTH,
  SIDE_BY_SIDE_MIN_WIDTH,
  sideBySideColumns,
  sideBySidePaneWidth,
  stageLayout,
  type ImageZoom,
  type Size,
} from './geometry';
import type { ImageDiffMode } from './imageDiffSettings';
import type { ImageSizes } from './imageSizes';
import { sidesFor } from './useImageSides';

export const IMAGE_PREVIEW_PADDING = 25;
export const IMAGE_CAPTION_HEIGHT = 24;
export const IMAGE_LABEL_ROW_HEIGHT = 24;
export const IMAGE_ROW_GAP = 12;

export function imagePreviewHeight(options: {
  sizes: ImageSizes[string] | undefined;
  status: DiffFileStatus;
  width: number;
  mode: ImageDiffMode;
  zoom: ImageZoom;
  dpr: number;
}): number | undefined {
  const { sizes, status, width } = options;
  if (!sizes || width <= 0) return undefined;
  const sideSize = (side: ReviewImageSide): Size | null => {
    const entry = sizes[side];
    return entry?.width && entry.height ? { width: entry.width, height: entry.height } : null;
  };
  const sides = sidesFor(status);
  if (sides.some((side) => sideSize(side) == null)) return undefined;
  const before = sides.includes('old') ? sideSize('old') : null;
  const after = sides.includes('new') ? sideSize('new') : null;
  const comparable = sides.length === 2;
  const mode = comparable ? options.mode : 'side';
  const canvas = { width: Math.max(before?.width ?? 0, after?.width ?? 0), height: Math.max(before?.height ?? 0, after?.height ?? 0) };
  const columnsFit = comparable && sideBySideColumns(canvas, width);
  const layout = stageLayout({
    old: before,
    new: after,
    available: { width: sideBySidePaneWidth(width, columnsFit), height: ALL_FILES_IMAGE_MAX_HEIGHT },
    zoom: options.zoom,
    dpr: options.dpr,
  });
  const box = Math.min(layout.stage.height, ALL_FILES_IMAGE_MAX_HEIGHT);
  const labelsAbove = width < SIDE_BY_SIDE_MIN_WIDTH || layout.stage.width < LABELS_OVER_MIN_WIDTH || box < LABELS_OVER_MIN_HEIGHT;
  const labels = labelsAbove ? IMAGE_LABEL_ROW_HEIGHT : 0;
  if (mode === 'swipe') return IMAGE_PREVIEW_PADDING + labels + box + IMAGE_CAPTION_HEIGHT;
  if (mode === 'onion') return IMAGE_PREVIEW_PADDING + box + IMAGE_CAPTION_HEIGHT;
  const figure = labels + box + IMAGE_CAPTION_HEIGHT;
  const rows = columnsFit ? 1 : sides.length;
  return IMAGE_PREVIEW_PADDING + rows * figure + (rows - 1) * IMAGE_ROW_GAP;
}
