import type { SidebarTab } from '@plannotator/ui/hooks/useSidebar';
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
