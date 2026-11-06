import type { ReactNode } from 'react';
import type { ShapeViewId } from '@plannotator/core/shape';
import type { ShapeBoxSelection, ShapeHost, ShapePanelTab } from '@plannotator/ui/components/shape';

export interface ShapeBoardProps {
  host: ShapeHost;
  id: string;
  /** The Pebble closes the board (back to the thread, or the grid). */
  onClose: () => void;
  /** The Thread tab (a board that hangs off a thread). */
  renderThread?: (options: { flash: string | null }) => ReactNode;
  /** Where to start, and the view or panel changed (the standalone page keeps its address in step). */
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  onNavigate?: (state: { view: ShapeViewId; panel: ShapePanelTab | null }) => void;
  /** Before the board's title (the Inbox's sidebar toggle). */
  headStart?: ReactNode;
  /** The crosshair in Annotate's place (a click marks a part, a drag draws a box). The Inbox's board only. */
  crosshair?: boolean;
  /** A dragged box's Add to reply: into the reply to the board's thread. Absent (no thread): no Add to reply. */
  onAddToReply?: (selection: ShapeBoxSelection, text: string) => void;
}
