import type { PaneTab } from './paneLayout';
import { REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';

const REFERENCES_PREFIX = 'References: ';

export function isReferencesTab(tab: PaneTab): boolean {
  return tab.component === REVIEW_PANEL_TYPES.CODE_NAV;
}

export function tabLabel(tab: PaneTab): string {
  return isReferencesTab(tab) && tab.title.startsWith(REFERENCES_PREFIX) ? tab.title.slice(REFERENCES_PREFIX.length) : tab.title;
}
