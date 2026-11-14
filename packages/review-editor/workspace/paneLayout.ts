export interface PaneTab {
  id: string;
  component: string;
  title: string;
  params: Record<string, unknown>;
}

export interface Pane {
  tabs: PaneTab[];
  activeId: string | null;
}

export interface PaneLayout {
  panes: Pane[];
  activePane: number;
}

export type PanePlacement =
  | { kind: 'active' }
  | { kind: 'with'; referenceId: string }
  | { kind: 'beside'; referenceId?: string };

export const MAX_PANES = 2;
export const REFERENCES_PANE_MIN_WIDTH = 1100;

export const EMPTY_LAYOUT: PaneLayout = { panes: [{ tabs: [], activeId: null }], activePane: 0 };

export function paneIndexOf(layout: PaneLayout, id: string): number {
  return layout.panes.findIndex((pane) => pane.tabs.some((tab) => tab.id === id));
}

export function findTab(layout: PaneLayout, id: string): PaneTab | undefined {
  for (const pane of layout.panes) {
    const tab = pane.tabs.find((candidate) => candidate.id === id);
    if (tab) return tab;
  }
  return undefined;
}

export function activeTabId(layout: PaneLayout): string | null {
  return layout.panes[layout.activePane]?.activeId ?? null;
}

function targetPane(layout: PaneLayout, placement: PanePlacement, singlePane: boolean): { panes: Pane[]; index: number } {
  const panes = layout.panes.map((pane) => ({ ...pane, tabs: [...pane.tabs] }));
  if (placement.kind === 'with') {
    const at = paneIndexOf(layout, placement.referenceId);
    return { panes, index: at === -1 ? layout.activePane : at };
  }
  if (placement.kind === 'beside' && !singlePane) {
    const from = placement.referenceId ? paneIndexOf(layout, placement.referenceId) : layout.activePane;
    const origin = from === -1 ? layout.activePane : from;
    if (panes.length < MAX_PANES) {
      panes.splice(origin + 1, 0, { tabs: [], activeId: null });
      return { panes, index: origin + 1 };
    }
    return { panes, index: origin === 0 ? 1 : 0 };
  }
  return { panes, index: Math.min(layout.activePane, panes.length - 1) };
}

export function addTab(layout: PaneLayout, tab: PaneTab, placement: PanePlacement, singlePane = false): PaneLayout {
  if (findTab(layout, tab.id)) return activateTab(layout, tab.id);
  const { panes, index } = targetPane(layout, placement, singlePane);
  const pane = panes[index]!;
  const after = pane.activeId ? pane.tabs.findIndex((candidate) => candidate.id === pane.activeId) + 1 : pane.tabs.length;
  pane.tabs.splice(after, 0, tab);
  pane.activeId = tab.id;
  return { panes, activePane: index };
}

export function activateTab(layout: PaneLayout, id: string): PaneLayout {
  const index = paneIndexOf(layout, id);
  if (index === -1) return layout;
  if (layout.activePane === index && layout.panes[index]!.activeId === id) return layout;
  const panes = layout.panes.map((pane, at) => (at === index ? { ...pane, activeId: id } : pane));
  return { panes, activePane: index };
}

export function focusPane(layout: PaneLayout, index: number): PaneLayout {
  if (index === layout.activePane || !layout.panes[index]) return layout;
  return { ...layout, activePane: index };
}

export function closeTab(layout: PaneLayout, id: string): PaneLayout {
  const index = paneIndexOf(layout, id);
  if (index === -1) return layout;
  const pane = layout.panes[index]!;
  const at = pane.tabs.findIndex((tab) => tab.id === id);
  const tabs = pane.tabs.filter((tab) => tab.id !== id);
  const activeId = pane.activeId === id ? (tabs[Math.min(at, tabs.length - 1)]?.id ?? null) : pane.activeId;
  if (tabs.length === 0 && layout.panes.length > 1) {
    const panes = layout.panes.filter((_, paneAt) => paneAt !== index);
    return { panes, activePane: Math.min(layout.activePane === index ? 0 : layout.activePane > index ? layout.activePane - 1 : layout.activePane, panes.length - 1) };
  }
  const panes = layout.panes.map((candidate, paneAt) => (paneAt === index ? { tabs, activeId } : candidate));
  return { ...layout, panes };
}

export function updateTab(layout: PaneLayout, id: string, patch: Partial<Pick<PaneTab, 'title' | 'params'>>): PaneLayout {
  const index = paneIndexOf(layout, id);
  if (index === -1) return layout;
  const panes = layout.panes.map((pane, at) =>
    at === index ? { ...pane, tabs: pane.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) } : pane,
  );
  return { ...layout, panes };
}

export function collapseToOnePane(layout: PaneLayout): PaneLayout {
  if (layout.panes.length < 2) return layout;
  const keep = layout.panes[layout.activePane]!;
  const tabs = layout.panes.flatMap((pane) => pane.tabs);
  return { panes: [{ tabs, activeId: keep.activeId }], activePane: 0 };
}

export function referencesPlacement(windowWidth: number, singlePane: boolean): 'pane' | 'panel' {
  return singlePane || windowWidth < REFERENCES_PANE_MIN_WIDTH ? 'panel' : 'pane';
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.8, Math.max(0.2, ratio));
}
