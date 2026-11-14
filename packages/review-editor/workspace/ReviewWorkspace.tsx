import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';
import { PaneDivider } from './PaneDivider';
import { PanePanels } from './PanePanels';
import { clampRatio, PANE_MIN_WIDTH } from './paneLayout';
import { WorkspaceStore, type WorkspaceApi } from './workspaceStore';
import { readSavedLayout, snapshotLayout, writeSavedLayout } from './layoutMemory';

export const PANE_RATIO_KEY = 'plannotator-review-pane-ratio';
const SAVE_DELAY_MS = 300;

function readRatio(): number {
  return clampRatio(Number.parseFloat(storage.getItem(PANE_RATIO_KEY) ?? '0.5'));
}

function useLayoutMemory(store: WorkspaceStore, reviewKey: string | undefined, ratio: number, setRatio: (ratio: number) => void) {
  const restoredRef = useRef(false);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = useRef(() => {});
  save.current = () => {
    if (!reviewKey || !restoredRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => writeSavedLayout(reviewKey, snapshotLayout(store.getLayout(), ratioRef.current)), SAVE_DELAY_MS);
  };

  useEffect(() => {
    if (!reviewKey) return;
    const saved = readSavedLayout(reviewKey);
    restoredRef.current = !saved;
    const added = store.api.onDidAddPanel(() => {
      if (restoredRef.current || !saved) return;
      restoredRef.current = true;
      queueMicrotask(() => {
        store.restore(saved);
        setRatio(clampRatio(saved.ratio));
      });
    });
    const unsubscribe = store.subscribe(() => save.current());
    return () => {
      added.dispose();
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [store, reviewKey, setRatio]);

  useEffect(() => {
    save.current();
  }, [ratio]);
}

export const ReviewWorkspace: React.FC<{
  onReady: (event: { api: WorkspaceApi }) => void;
  singlePane?: boolean;
  reviewKey?: string;
  className?: string;
}> = ({ onReady, singlePane = false, reviewKey, className }) => {
  const store = useMemo(() => new WorkspaceStore(), []);
  const layout = useSyncExternalStore(store.subscribe, store.getLayout, store.getLayout);
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

  useLayoutMemory(store, reviewKey, ratio, setRatio);

  const paneCount = layout.panes.length;
  useLayoutEffect(() => {
    const sideWidth = store.takeSideWidth();
    const width = rowRef.current?.clientWidth ?? 0;
    if (paneCount === 2 && sideWidth && width > 0) setRatio(clampRatio(1 - sideWidth / width));
  }, [store, paneCount]);

  const commitRatio = (next: number) => {
    setRatio(next);
    storage.setItem(PANE_RATIO_KEY, String(Math.round(next * 1000) / 1000));
  };

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
            data-active-pane-group={layout.activePane === index ? '' : undefined}
            aria-label={index === 0 ? 'Main pane' : 'Side pane'}
            className="min-w-0 min-h-0 flex flex-col"
            style={two ? { flex: `${index === 0 ? ratio : 1 - ratio} 1 0`, minWidth: `min(${PANE_MIN_WIDTH}px, 50%)` } : { flex: '1 1 0' }}
            onPointerDownCapture={() => store.focusPane(index)}
            onFocusCapture={() => store.focusPane(index)}
          >
            <PanePanels pane={pane} paneIndex={index} store={store} deferFirstMount={index === 1} />
          </section>
        </React.Fragment>
      ))}
    </div>
  );
};
