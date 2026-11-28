import type { DockviewApi } from 'dockview-react';
import { REVIEW_ALL_FILES_PANEL_ID, isReviewDiffPanelId } from './reviewPanelTypes';

export function hidesDockHeader(groupCount: number, panelIds: readonly string[]): boolean {
  if (groupCount !== 1 || panelIds.length !== 1) return false;
  const [only] = panelIds;
  return only === REVIEW_ALL_FILES_PANEL_ID || isReviewDiffPanelId(only);
}

export function watchLoneTabHeader(api: DockviewApi, onAllChangesOpen: (open: boolean) => void): void {
  const update = () => {
    const hide = hidesDockHeader(api.groups.length, api.panels.map((panel) => panel.id));
    for (const group of api.groups) group.header.hidden = hide;
    onAllChangesOpen(!!api.getPanel(REVIEW_ALL_FILES_PANEL_ID));
  };
  api.onDidAddPanel(update);
  api.onDidRemovePanel(update);
  api.onDidAddGroup(update);
  api.onDidRemoveGroup(update);
  api.onDidMovePanel(update);
  api.onDidLayoutChange(update);
  update();
}
