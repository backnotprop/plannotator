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

export function toggleCompactPlanNavigator(
  surface: CompactPlanSurface,
  tab: SidebarTab,
): CompactPlanSurface {
  if (surface.type === 'navigator' && surface.tab === tab) {
    return COMPACT_PLAN_ARTIFACT;
  }
  return openCompactPlanNavigator(tab);
}

export function shouldPresentDesktopPlanPanel(
  compactTouchLayout: boolean,
  desktopPanelOpen: boolean,
): boolean {
  return !compactTouchLayout && desktopPanelOpen;
}
