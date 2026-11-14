import { storage } from '@plannotator/ui/utils/storage';
import type { PaneLayout, PaneTab } from './paneLayout';

export const LAYOUT_MEMORY_KEY = 'plannotator-review-layouts';
const MAX_REVIEWS = 6;
const MAX_TABS_PER_PANE = 8;
const RESTORABLE = new Set(['review-all-files', 'review-diff', 'review-file', 'review-pr-overview', 'review-pr-artifacts', 'review-semantic-diff', 'review-call-flow']);

export interface SavedLayout {
  panes: { tabs: PaneTab[]; activeId: string | null }[];
  activePane: number;
  ratio: number;
}

type Memory = { order: string[]; layouts: Record<string, SavedLayout> };

function readMemory(): Memory {
  try {
    const parsed = JSON.parse(storage.getItem(LAYOUT_MEMORY_KEY) ?? '') as Memory;
    if (Array.isArray(parsed.order) && parsed.layouts && typeof parsed.layouts === 'object') return parsed;
  } catch {}
  return { order: [], layouts: {} };
}

export function restorableTab(tab: PaneTab): boolean {
  return RESTORABLE.has(tab.component);
}

export function snapshotLayout(layout: PaneLayout, ratio: number): SavedLayout | null {
  const panes = layout.panes
    .map((pane) => {
      const tabs = pane.tabs.filter(restorableTab).slice(0, MAX_TABS_PER_PANE);
      return { tabs, activeId: tabs.some((tab) => tab.id === pane.activeId) ? pane.activeId : tabs[0]?.id ?? null };
    })
    .filter((pane) => pane.tabs.length > 0);
  if (panes.length === 0) return null;
  return { panes, activePane: Math.min(layout.activePane, panes.length - 1), ratio };
}

export function readSavedLayout(reviewKey: string): SavedLayout | null {
  return readMemory().layouts[reviewKey] ?? null;
}

export function writeSavedLayout(reviewKey: string, saved: SavedLayout | null): void {
  const memory = readMemory();
  const order = memory.order.filter((key) => key !== reviewKey);
  const layouts = { ...memory.layouts };
  if (saved) {
    order.unshift(reviewKey);
    layouts[reviewKey] = saved;
  } else {
    delete layouts[reviewKey];
  }
  for (const stale of order.splice(MAX_REVIEWS)) delete layouts[stale];
  storage.setItem(LAYOUT_MEMORY_KEY, JSON.stringify({ order, layouts }));
}
