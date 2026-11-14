import React, { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Pane } from './paneLayout';
import type { WorkspaceStore } from './workspaceStore';
import { reviewPanelComponents } from '../dock/reviewPanelComponents';

type PanelComponent = React.ComponentType<{ api: unknown; params: Record<string, unknown>; containerApi: unknown }>;
type ScrollMemory = Map<Element, { top: number; left: number }>;

const hosts = new WeakMap<WorkspaceStore, Map<string, HTMLDivElement>>();

function hostFor(store: WorkspaceStore, id: string): HTMLDivElement {
  let byId = hosts.get(store);
  if (!byId) {
    byId = new Map();
    hosts.set(store, byId);
  }
  let host = byId.get(id);
  if (!host) {
    host = document.createElement('div');
    host.className = 'absolute inset-0 overflow-hidden';
    host.setAttribute('data-pane-panel', id);
    byId.set(id, host);
  }
  return host;
}

function rememberScroll(root: Element): ScrollMemory {
  const memory: ScrollMemory = new Map();
  const visit = (element: Element) => {
    if (element.scrollTop !== 0 || element.scrollLeft !== 0) memory.set(element, { top: element.scrollTop, left: element.scrollLeft });
    for (const child of element.children) visit(child);
    const shadow = (element as HTMLElement).shadowRoot;
    if (shadow) for (const child of shadow.children) visit(child);
  };
  visit(root);
  return memory;
}

function restoreScroll(memory: ScrollMemory | undefined) {
  if (!memory) return;
  for (const [element, at] of memory) {
    element.scrollTop = at.top;
    element.scrollLeft = at.left;
  }
}

export const PanePanels: React.FC<{ pane: Pane; store: WorkspaceStore }> = ({ pane, store }) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const scrolls = useRef(new Map<string, ScrollMemory>());

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const activeId = pane.activeId;
    for (const child of [...frame.children]) {
      const id = child.getAttribute('data-pane-panel');
      if (id && id !== activeId) {
        scrolls.current.set(id, rememberScroll(child));
        child.remove();
      }
    }
    if (!activeId) return;
    const host = hostFor(store, activeId);
    if (host.parentElement !== frame) {
      frame.appendChild(host);
      restoreScroll(scrolls.current.get(activeId));
      requestAnimationFrame(() => restoreScroll(scrolls.current.get(activeId)));
    }
  }, [pane.activeId, store]);

  useLayoutEffect(() => {
    const ids = new Set(pane.tabs.map((tab) => tab.id));
    for (const id of [...scrolls.current.keys()]) if (!ids.has(id)) scrolls.current.delete(id);
  }, [pane.tabs]);

  return (
    <div ref={frameRef} className="relative flex-1 min-h-0" data-pane-frame="">
      {pane.tabs.map((tab) => {
        const Component = (reviewPanelComponents as unknown as Record<string, PanelComponent>)[tab.component];
        const handle = store.api.getPanel(tab.id);
        if (!Component || !handle) return null;
        return (
          <React.Fragment key={tab.id}>
            {createPortal(<Component api={handle.api} params={tab.params} containerApi={store.api} />, hostFor(store, tab.id))}
          </React.Fragment>
        );
      })}
    </div>
  );
};
