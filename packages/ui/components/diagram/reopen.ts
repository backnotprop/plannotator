import type { DiagramAnchor } from '@plannotator/core/diagram-anchor';

export interface DiagramReopenRequest {
  readonly anchor: DiagramAnchor;
  readonly text: string;
  readonly onMissing?: () => void;
}
