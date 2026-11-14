import type { PaneTab } from './paneLayout';
import { REVIEW_ALL_FILES_PANEL_ID, REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';

const REFERENCES_PREFIX = 'References: ';

export function isReferencesTab(tab: PaneTab): boolean {
  return tab.component === REVIEW_PANEL_TYPES.CODE_NAV;
}

export function tabLabel(tab: PaneTab): string {
  return isReferencesTab(tab) && tab.title.startsWith(REFERENCES_PREFIX) ? tab.title.slice(REFERENCES_PREFIX.length) : tab.title;
}

export function isClosableTab(tab: PaneTab): boolean {
  return tab.id !== REVIEW_ALL_FILES_PANEL_ID;
}

export function tabKind(tab: PaneTab): 'diff' | 'file' | null {
  if (tab.component === REVIEW_PANEL_TYPES.DIFF) return 'diff';
  if (tab.component === REVIEW_PANEL_TYPES.FILE) return 'file';
  return null;
}

export function tabTooltip(tab: PaneTab): string {
  const kind = tabKind(tab);
  if (kind === 'diff') return `Diff of ${tab.title}`;
  if (kind === 'file') return `File ${tab.title}`;
  return tab.title;
}
