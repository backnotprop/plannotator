import React, { useSyncExternalStore } from 'react';
import type { WorkspaceStore } from './workspaceStore';
import { PaneTabs } from './PaneTabs';
import { useReviewStateOptional } from '../dock/ReviewStateContext';

export const PaneTabRow: React.FC<{ store: WorkspaceStore; paneIndex: number; variant: 'header' | 'slim' }> = ({ store, paneIndex, variant }) => {
  const layout = useSyncExternalStore(store.subscribe, store.getLayout, store.getLayout);
  const state = useReviewStateOptional();
  const pane = layout.panes[paneIndex];
  if (!pane) return null;
  const tabs = (
    <PaneTabs
      pane={pane}
      paneIndex={paneIndex}
      onActivate={(id) => store.api.getPanel(id)?.api.setActive()}
      onClose={(id) => store.api.getPanel(id)?.api.close()}
      onKeep={state?.onKeepFileTab}
    />
  );
  if (variant === 'header') return <div className="min-w-0 flex-1 self-stretch flex items-stretch" data-pane-tab-row="header">{tabs}</div>;
  return (
    <div className="flex-none h-7 px-3 flex items-stretch border-b border-border/50" data-pane-tab-row="slim">
      {tabs}
    </div>
  );
};
