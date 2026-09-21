import type { SidebarTab } from '@plannotator/ui/hooks/useSidebar';
import type { WideModeType } from '@plannotator/ui/types';
export type { WideModeType } from '@plannotator/ui/types';

export type WideModeLayoutSnapshot = {
  sidebarIsOpen: boolean;
  sidebarTab: SidebarTab;
  panelOpen: boolean;
};

export type WideModeExitOptions = {
  restore?: boolean;
  sidebarTab?: SidebarTab;
  panelOpen?: boolean;
};

export type WideModeExitLayout = {
  sidebarOpen: boolean;
  sidebarTab: SidebarTab | null;
  panelOpen?: boolean;
};

export function canUseAnnotateWideMode(options: {
  archiveMode: boolean;
  isPlanDiffActive: boolean;
}): boolean {
  return !options.archiveMode && !options.isPlanDiffActive;
}

/** What the focus-mode keyboard shortcut should do on this press. */
export type FocusShortcutAction = 'enter-focus' | 'exit' | 'none';

/**
 * Decide the next step for the focus-mode keyboard shortcut.
 *
 * The shortcut is a single "hide the chrome / give it back" toggle, so ANY
 * active panel-hiding view mode restores the remembered layout — including
 * `wide`, which the toolbar control would instead swap for `focus`. A press
 * that could only re-hide already-hidden panels would look like a dead key.
 */
export function resolveFocusShortcutAction(state: {
  canUseWideMode: boolean;
  wideModeType: WideModeType | null;
}): FocusShortcutAction {
  if (state.wideModeType !== null) return 'exit';
  return state.canUseWideMode ? 'enter-focus' : 'none';
}

export function resolveWideModeExitLayout(
  snapshot: WideModeLayoutSnapshot | null,
  options?: WideModeExitOptions,
): WideModeExitLayout {
  const restore = options?.restore !== false;

  if (options?.sidebarTab) {
    return {
      sidebarOpen: true,
      sidebarTab: options.sidebarTab,
      panelOpen: options.panelOpen,
    };
  }

  return {
    sidebarOpen: restore ? (snapshot?.sidebarIsOpen ?? false) : false,
    sidebarTab: restore && snapshot?.sidebarIsOpen ? snapshot.sidebarTab : null,
    panelOpen: options?.panelOpen ?? (restore ? (snapshot?.panelOpen ?? false) : undefined),
  };
}
