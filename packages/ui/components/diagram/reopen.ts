import type { DiagramAnchor } from '@plannotator/core/diagram-anchor';

/**
 * A comment being written that a host kept and asks to put back
 * (`ViewerHandle.reopenComment` on a diagram part): the diagram opens its
 * composer at the part once it is drawn, holding the words. Each new object
 * opens it once; `onMissing` runs when the part is not in the render.
 */
export interface DiagramReopenRequest {
  readonly anchor: DiagramAnchor;
  readonly text: string;
  readonly onMissing?: () => void;
}
