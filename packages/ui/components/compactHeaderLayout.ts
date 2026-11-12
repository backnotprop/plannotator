export type CompactHeaderLayout = 'wide' | 'tight' | 'narrow';

export interface CompactHeaderMeasurements {
  readonly containerWidth: number;
  readonly trailingWidth: number;
  readonly leadingInset: number;
}

export interface CompactHeaderGeometry {
  readonly availableForLeading: number;
  readonly layout: CompactHeaderLayout;
  readonly measured: boolean;
}

const GRID_SIZE = 16;
const CLUSTER_GAP = 16;
const WIDE_LEADING_WIDTH = 460;
const MIN_LEADING_WIDTH = 300;

export function snapCompactHeaderWidth(width: number): number {
  return Math.floor(width / GRID_SIZE) * GRID_SIZE;
}

export function resolveCompactHeaderGeometry({
  containerWidth,
  trailingWidth,
  leadingInset,
}: CompactHeaderMeasurements): CompactHeaderGeometry {
  const measured = containerWidth > 0 && trailingWidth > 0;
  const availableForLeading = containerWidth - leadingInset - trailingWidth - CLUSTER_GAP;
  const layout = !measured || availableForLeading >= WIDE_LEADING_WIDTH
    ? 'wide'
    : availableForLeading >= MIN_LEADING_WIDTH
      ? 'tight'
      : 'narrow';

  return { availableForLeading, layout, measured };
}
