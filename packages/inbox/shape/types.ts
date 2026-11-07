import type { ReactNode } from 'react';
import type { ShapeCodeTarget, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';
import type { ShapeBoxSelection, ShapeHost, ShapePanelTab, ShapeSurfaceReview } from '@plannotator/ui/components/shape';

export interface ShapeBoardProps {
  host: ShapeHost;
  id: string;
  /** The Pebble closes the board (back to the thread, or the grid). */
  onClose: () => void;
  /** A part's code, when the host shows it itself (code review's diff). False: the board's own viewer. */
  onCode?: (target: ShapeCodeTarget, el: HTMLElement, version?: ShapeVersion | null) => boolean;
  /** The Thread tab (a board that hangs off a thread). */
  renderThread?: (options: { flash: string | null }) => ReactNode;
  /** Where to start, and the view or panel changed (the standalone page keeps its address in step). */
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  onNavigate?: (state: ShapeBoardPlace) => void;
  /** Before the board's title (the Inbox's sidebar toggle). */
  headStart?: ReactNode;
  /** The review the board is part of (its thread's): What's changed's buttons and links, and where `file:line` opens. */
  review?: ShapeSurfaceReview | null;
  /** The crosshair in Annotate's place (a click marks a part, a drag draws a box). The Inbox's board only. */
  crosshair?: boolean;
  /** A dragged box's Add to reply: into the reply to the board's thread. Absent (no thread): no Add to reply. */
  onAddToReply?: (selection: ShapeBoxSelection, text: string) => void;
}

/** Where the person is on a board: its view and its open panel. */
export interface ShapeBoardPlace {
  view: ShapeViewId;
  panel: ShapePanelTab | null;
}
