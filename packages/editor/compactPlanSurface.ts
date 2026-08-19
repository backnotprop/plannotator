import type { SidebarTab } from '@plannotator/ui/hooks/useSidebar';

/**
 * The compact Plan shell presents one foreground task at a time. Navigator,
 * annotations, AI, and review all replace the artifact instead of competing
 * with it for horizontal space.
 */
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
 * The header trigger behaves like a disclosure: it returns to the document
 * when the currently visible navigator is invoked again, and otherwise opens
 * the requested tab. Tabs inside the navigator use openCompactPlanNavigator
 * directly so tapping the active tab never dismisses the surface.
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
