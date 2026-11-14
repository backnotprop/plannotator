import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { reviewPanelComponents } from '../dock/reviewPanelComponents';
import { hidesDockHeader } from '../dock/loneTabHeader';
import { useReviewStateOptional } from '../dock/ReviewStateContext';
import { PaneTabs } from './PaneTabs';
import { PaneDivider } from './PaneDivider';
import { clampRatio } from './paneLayout';
import { WorkspaceStore, type WorkspaceApi } from './workspaceStore';

export const PANE_RATIO_KEY = 'plannotator-review-pane-ratio';

function readRatio(): number {
  return clampRatio(Number.parseFloat(storage.getItem(PANE_RATIO_KEY) ?? '0.5'));
}

type PanelComponent = React.ComponentType<{ api: unknown; params: Record<string, unknown>; containerApi: unknown }>;

export const ReviewWorkspace: React.FC<{
  onReady: (event: { api: WorkspaceApi }) => void;
  singlePane?: boolean;
  className?: string;
}> = ({ onReady, singlePane = false, className }) => {
  const store = useMemo(() => new WorkspaceStore(), []);
  const layout = useSyncExternalStore(store.subscribe, store.getLayout, store.getLayout);
  const state = useReviewStateOptional();
  const [ratio, setRatio] = useState(readRatio);
  const rowRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    store.setSinglePane(singlePane);
  }, [store, singlePane]);

  useEffect(() => {
    readyRef.current({ api: store.api });
  }, [store]);

  const commitRatio = (next: number) => {
    setRatio(next);
    storage.setItem(PANE_RATIO_KEY, String(Math.round(next * 1000) / 1000));
  };

  const ids = layout.panes.flatMap((pane) => pane.tabs.map((tab) => tab.id));
  const hideTabs = hidesDockHeader(layout.panes.length, ids);
  const two = layout.panes.length === 2;

  return (
    <div ref={rowRef} className={`flex h-full min-w-0 ${className ?? ''}`} data-review-workspace="">
      {layout.panes.map((pane, index) => (
        <React.Fragment key={index}>
          {index === 1 && (
            <PaneDivider ratio={ratio} onChange={setRatio} onCommit={commitRatio} container={() => rowRef.current} />
          )}
          <section
            ref={(element) => store.setPaneElement(index, element)}
            data-pane={index}
            data-pane-active={two && layout.activePane === index ? '' : undefined}
            aria-label={index === 0 ? 'Main pane' : 'Side pane'}
            className="min-w-0 min-h-0 flex flex-col"
            style={two ? { flex: `${index === 0 ? ratio : 1 - ratio} 1 0` } : { flex: '1 1 0' }}
            onPointerDownCapture={() => store.focusPane(index)}
            onFocusCapture={() => store.focusPane(index)}
          >
            {!hideTabs && (
              <PaneTabs
                pane={pane}
                paneIndex={index}
                onActivate={(id) => store.api.getPanel(id)?.api.setActive()}
                onClose={(id) => store.api.getPanel(id)?.api.close()}
                onKeep={state?.onKeepFileTab}
              />
            )}
            <div className="relative flex-1 min-h-0">
              {pane.tabs.map((tab) => {
                const Component = (reviewPanelComponents as unknown as Record<string, PanelComponent>)[tab.component];
                const handle = store.api.getPanel(tab.id);
                if (!Component || !handle) return null;
                const visible = tab.id === pane.activeId;
                return (
                  <div
                    key={tab.id}
                    role="tabpanel"
                    data-pane-panel={tab.id}
                    aria-hidden={!visible || undefined}
                    inert={!visible || undefined}
                    data-pane-panel-visible={visible || undefined}
                    className={`absolute inset-0 overflow-hidden ${visible ? '' : 'invisible pointer-events-none'}`}
                  >
                    <Component api={handle.api} params={tab.params} containerApi={store.api} />
                  </div>
                );
              })}
            </div>
          </section>
        </React.Fragment>
      ))}
    </div>
  );
};
