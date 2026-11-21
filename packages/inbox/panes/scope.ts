import { createContext, useContext } from 'react';
import { useShortcutScope as useRegistryScope, type ShortcutScopeDefinition, type UseShortcutScopeOptions } from '@plannotator/ui/shortcuts';
import { MAIN_PANE, type PaneId } from './model';

export interface PaneScopeValue {
  paneId: PaneId;
  /** The pane keys go to and whose messages count as seen (model.ts). */
  active: boolean;
}

/** The thread pane a component is drawn in. Outside any slot (a test, a page with no panes): the main pane, active. */
export const PaneScopeContext = createContext<PaneScopeValue>({ paneId: MAIN_PANE, active: true });

export const usePaneScope = (): PaneScopeValue => useContext(PaneScopeContext);

const NO_HANDLERS = {};

/** The registry's scope, deaf in a pane that is not the active one: its keys belong to the active pane. */
export function useShortcutScope<TScope extends ShortcutScopeDefinition<any>>(options: UseShortcutScopeOptions<TScope>): void {
  const { active } = usePaneScope();
  useRegistryScope(active ? options : { ...options, handlers: NO_HANDLERS });
}
