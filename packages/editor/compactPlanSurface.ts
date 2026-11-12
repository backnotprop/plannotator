import type { SidebarTab } from '@plannotator/ui/hooks/useSidebar';

export type CompactPlanSurface =
  | { readonly type: 'artifact' }
  | { readonly type: 'navigator'; readonly tab: SidebarTab }
  | { readonly type: 'annotations' }
  | { readonly type: 'ai' }
  | { readonly type: 'review' };

export const COMPACT_PLAN_ARTIFACT: CompactPlanSurface = { type: 'artifact' };

export function openCompactPlanNavigator(tab: SidebarTab): CompactPlanSurface {
  return { type: 'navigator', tab };
}

/**
 * The header trigger behaves like a disclosure: it returns to the document when the currently
 * visible navigator is invoked again, and otherwise opens the requested tab.
 */
export function toggleCompactPlanNavigator(
  surface: CompactPlanSurface,
  tab: SidebarTab,
): CompactPlanSurface {
  if (surface.type === 'navigator' && surface.tab === tab) {
    return COMPACT_PLAN_ARTIFACT;
  }
  return openCompactPlanNavigator(tab);
}

/** Compact foreground surfaces never borrow the desktop panel presentation. */
export function shouldPresentDesktopPlanPanel(
  compactTouchLayout: boolean,
  desktopPanelOpen: boolean,
): boolean {
  return !compactTouchLayout && desktopPanelOpen;
}
