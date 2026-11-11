import type { ReactNode } from 'react';
import type { ShapeCodeTarget, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';
import type { ShapeBoxSelection, ShapeHost, ShapePanelTab, ShapeSurfaceReview } from '@plannotator/ui/components/shape';

export interface ShapeBoardProps {
  host: ShapeHost;
  id: string;
  onClose: () => void;
  onCode?: (target: ShapeCodeTarget, el: HTMLElement, version?: ShapeVersion | null) => boolean;
  renderThread?: (options: { flash: string | null }) => ReactNode;
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  onNavigate?: (state: ShapeBoardPlace) => void;
  headStart?: ReactNode;
  headSide?: ReactNode;
  review?: ShapeSurfaceReview | null;
  crosshair?: boolean;
  onAddToReply?: (selection: ShapeBoxSelection, text: string) => void;
}

export interface ShapeBoardPlace {
  view: ShapeViewId;
  panel: ShapePanelTab | null;
}
