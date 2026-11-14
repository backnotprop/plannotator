import React, { useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { reviewPanelComponents } from '../dock/reviewPanelComponents';
import { ReviewDockTabRenderer } from '../dock/ReviewDockTabRenderer';
import { ReviewWorkspace } from './ReviewWorkspace';
import { usesPaneLayout } from './layoutEngine';

export const ReviewCenterArea: React.FC<{
  onReady: (event: DockviewReadyEvent) => void;
  mode: 'light' | 'dark';
  singlePane: boolean;
  tabsSlot?: HTMLElement | null;
  reviewKey?: string;
}> = ({ onReady, mode, singlePane, tabsSlot, reviewKey }) => {
  const [panes] = useState(usesPaneLayout);
  if (panes) {
    return <ReviewWorkspace onReady={onReady as unknown as Parameters<typeof ReviewWorkspace>[0]['onReady']} singlePane={singlePane} tabsSlot={tabsSlot} reviewKey={reviewKey} />;
  }
  return (
    <DockviewReact
      className={`h-full ${mode === 'light' ? 'dockview-theme-light' : 'dockview-theme-dark'}`}
      components={reviewPanelComponents}
      defaultTabComponent={ReviewDockTabRenderer}
      onReady={onReady}
      disableFloatingGroups
    />
  );
};
