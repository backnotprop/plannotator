import React, { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { phoneDiffStyle } from '../utils/phoneLayout';
import type { WorkspaceStore } from './workspaceStore';
import { REVIEW_PANEL_TYPES } from '../dock/reviewPanelTypes';
import { PaneTabRow } from './PaneTabRow';

const HOSTS_TAB_ROW = new Set<string>([REVIEW_PANEL_TYPES.DIFF, REVIEW_PANEL_TYPES.FILE]);

export interface PaneSlot {
  store: WorkspaceStore;
  paneIndex: number;
  tabId: string;
  component: string;
}

export const PaneSlotContext = createContext<PaneSlot | null>(null);

export function hostsTabRow(component: string): boolean {
  return HOSTS_TAB_ROW.has(component);
}

export function usePaneTabsInHeader(): React.ReactNode {
  const slot = useContext(PaneSlotContext);
  const store = slot?.store;
  const active = useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    () => (slot && store ? store.getLayout().panes[slot.paneIndex]?.activeId === slot.tabId : false),
  );
  const hosts = !!slot && hostsTabRow(slot.component) && active;
  return hosts && slot ? <PaneTabRow store={slot.store} paneIndex={slot.paneIndex} variant="header" /> : null;
}

function noopSubscribe() {
  return () => {};
}

export const UNIFIED_PANE_WIDTH = 640;

export function usePaneDiffStyle(saved: 'split' | 'unified'): 'split' | 'unified' {
  const slot = useContext(PaneSlotContext);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const pane = slot?.store.paneElement(slot.paneIndex);
    if (!pane) return;
    const measure = () => setNarrow(pane.clientWidth > 0 && pane.clientWidth < UNIFIED_PANE_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [slot]);
  return phoneDiffStyle(narrow, saved);
}
