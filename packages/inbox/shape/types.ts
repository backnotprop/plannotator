import type { ReactNode } from 'react';
import type { ShapeCodeTarget, ShapeViewId } from '@plannotator/core/shape';
import type { ShapeHost, ShapePanelTab } from '@plannotator/ui/components/shape';

export interface ShapeBoardProps {
  host: ShapeHost;
  id: string;
  /** The Pebble closes the board (back to the thread, or the grid). */
  onClose: () => void;
  /** A part's code, when the host shows it itself (code review's diff). False: the board's own viewer. */
  onCode?: (target: ShapeCodeTarget, el: HTMLElement) => boolean;
  /** The Thread tab (a board that hangs off a thread). */
  renderThread?: (options: { flash: string | null }) => ReactNode;
  /** Where to start, and the view or panel changed (the standalone page keeps its address in step). */
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  onNavigate?: (state: { view: ShapeViewId; panel: ShapePanelTab | null }) => void;
}
