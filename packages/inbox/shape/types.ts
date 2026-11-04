import type { ReactNode } from 'react';
import type { ShapeHost } from '@plannotator/ui/components/shape';

export interface ShapeBoardProps {
  host: ShapeHost;
  id: string;
  /** The Pebble closes the board (back to the thread, or the grid). */
  onClose: () => void;
  /** The Thread tab (a board that hangs off a thread). */
  renderThread?: (options: { flash: string | null }) => ReactNode;
}
