import type { ReactNode } from 'react';
import type { ShapeViewId } from '@plannotator/core/shape';
import type { ShapeHost, ShapePanelTab, ShapeSurfaceReview } from '@plannotator/ui/components/shape';

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
  /** The review the board is part of (its thread's): What's changed's buttons and links, and where `file:line` opens. */
  review?: ShapeSurfaceReview | null;
}
