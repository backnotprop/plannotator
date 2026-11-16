import React, { createContext, useContext, useEffect, useState } from 'react';
import { phoneDiffStyle } from '../utils/phoneLayout';
import type { WorkspaceStore } from './workspaceStore';

export interface PaneSlot {
  store: WorkspaceStore;
  paneIndex: number;
  tabId: string;
  component: string;
}

export const PaneSlotContext = createContext<PaneSlot | null>(null);

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
