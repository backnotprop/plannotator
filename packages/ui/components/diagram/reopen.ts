import type { DiagramAnchor } from '@plannotator/core/diagram-anchor';

/**
 * A comment being written that a host kept and asks to put back (`ViewerHandle.reopenComment` on
 * a diagram part).
 */
export interface DiagramReopenRequest {
  readonly anchor: DiagramAnchor;
  readonly text: string;
  readonly onMissing?: () => void;
}
