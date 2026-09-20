/** Responsive presentation chosen for a measured compact document header. */
export type CompactHeaderLayout = 'wide' | 'tight' | 'narrow';

/** Measurements used to place a compact leading lane beside trailing actions. */
export interface CompactHeaderMeasurements {
  /** Measured width of the full header container. */
  readonly containerWidth: number;
  /** Measured width occupied by the trailing action cluster. */
  readonly trailingWidth: number;
  /** Leading inset that is unavailable to the compact controls. */
  readonly leadingInset: number;
}

/** Resolved responsive geometry for a compact document header. */
export interface CompactHeaderGeometry {
  /** Pixels available to the leading controls after actions and spacing. */
  readonly availableForLeading: number;
  /** Whether controls keep labels, become icon-only, or stack. */
  readonly layout: CompactHeaderLayout;
  /** Whether both required measurements have arrived. */
  readonly measured: boolean;
}

const GRID_SIZE = 16;
const CLUSTER_GAP = 16;
const WIDE_LEADING_WIDTH = 460;
const MIN_LEADING_WIDTH = 300;

/**
 * Quantize a ResizeObserver width to avoid rendering for every dragged pixel.
 * Floors toward the more conservative responsive layout.
 */
export function snapCompactHeaderWidth(width: number): number {
  return Math.floor(width / GRID_SIZE) * GRID_SIZE;
}

/** Resolve the shared wide, tight, and narrow compact-header states. */
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
