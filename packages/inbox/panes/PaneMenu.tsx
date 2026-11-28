import { createContext, useContext } from 'react';
import { Menu } from '@base-ui/react/menu';
import type { Edge } from '@plannotator/vendor-pierre-layouts';
import { Icon } from '../icons';

/**
 * A pane's own actions in its header's ⋯ menu (components/CopyMenus.tsx `ThreadMore`), the menu way to do what a drag
 * does: move the pane past its neighbour on any side, or close it. Only beside other panes: with one pane (and
 * without the switch) nothing provides it, so the menu is today's.
 */
export interface PaneMenu {
  /** The sides the pane can move to now: a pane is there and the layout still fits after the move. */
  moves: () => readonly Edge[];
  move: (edge: Edge) => void;
  close: () => void;
}

export const PaneMenuContext = createContext<PaneMenu | null>(null);

const MOVES: Record<Edge, { label: string; icon: 'back' | 'arrowRight' | 'arrowUp' | 'arrowDown' }> = {
  left: { label: 'Move pane left', icon: 'back' },
  right: { label: 'Move pane right', icon: 'arrowRight' },
  top: { label: 'Move pane up', icon: 'arrowUp' },
  bottom: { label: 'Move pane down', icon: 'arrowDown' },
};

/** The pane's group, at the top of the ⋯ menu, under the launched session's own group. */
export function PaneMenuItems() {
  const pane = useContext(PaneMenuContext);
  if (!pane) return null;
  return (
    <>
      {pane.moves().map((edge) => (
        <Menu.Item key={edge} className="ib-pmi" label={MOVES[edge].label} onClick={() => pane.move(edge)} data-pane-move={edge}>
          <Icon name={MOVES[edge].icon} size={15} />
          {MOVES[edge].label}
        </Menu.Item>
      ))}
      <Menu.Item className="ib-pmi" label="Close pane" onClick={pane.close} data-pane-close="">
        <Icon name="x" size={15} />
        Close pane
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
    </>
  );
}
