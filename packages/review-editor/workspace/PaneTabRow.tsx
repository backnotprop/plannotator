import React, { useSyncExternalStore } from 'react';
import type { WorkspaceStore } from './workspaceStore';
import { PaneTabs } from './PaneTabs';
import { useReviewStateOptional } from '../dock/ReviewStateContext';

export const PaneTabRow: React.FC<{ store: WorkspaceStore; paneIndex: number }> = ({ store, paneIndex }) => {
  const layout = useSyncExternalStore(store.subscribe, store.getLayout, store.getLayout);
  const state = useReviewStateOptional();
  const pane = layout.panes[paneIndex];
  if (!pane) return null;
  return (
    <div
      className="flex-none pl-3 pr-2 flex items-stretch border-b border-border"
      style={{ height: 'var(--panel-header-h)' }}
      data-pane-tab-row=""
    >
      <PaneTabs
        pane={pane}
        paneIndex={paneIndex}
        onActivate={(id) => store.api.getPanel(id)?.api.setActive()}
        onClose={(id) => store.api.getPanel(id)?.api.close()}
        onKeep={state?.onKeepFileTab}
      />
    </div>
  );
};
