import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { LayoutStore, naryTree, type ChildSize, type LayoutNode, type PaneNode } from '@plannotator/vendor-pierre-layouts';
import { Layout } from '@plannotator/vendor-pierre-layouts/react';
import type { PaneId } from './layoutModel';

export interface FreeLayoutProps {
  /** The tree to draw: the layout's, with the panes that stepped aside for room hidden (layoutRoom.ts). */
  tree: LayoutNode;
  active: PaneId;
  gap: number;
  /** The pane's thread's subject, for its accessible name and a drag's pill. */
  title: (id: PaneId) => string;
  /** Stable across draws: a pane's content follows the window through context (ThreadPanes.tsx). */
  renderPane: (pane: PaneNode) => ReactNode;
  onFocus: (id: PaneId) => void;
  onResize: (sizes: Readonly<Record<string, readonly ChildSize[]>>) => void;
}

const NO_ACTIONS = [] as const;
const noHeader = () => null;

/**
 * Several thread panes, placed by @pierre/layouts (packages/vendor-pierre-layouts). The layout's tree is the truth:
 * it is pushed into the engine's store on every change, and what the engine does on its own (a divider dragged)
 * comes back through `onResize` and `onFocus`. The engine draws no header and no actions of its own: each pane's
 * header is the thread's. A pane's content is a node the pane keeper puts in its place (paneKeeper.tsx), which hears
 * the presses and focus in it: one makes the pane active, and a press on its header (not on a control) that moves
 * 5 px picks it up (paneDrag.ts); where it lands is the drop target ThreadPanes registers (paneDrop.ts).
 */
export default function FreeLayout({ tree, active, gap, title, renderPane, onFocus, onResize }: FreeLayoutProps) {
  const [store] = useState(() => new LayoutStore(tree, { model: naryTree }));
  const pushed = useRef<LayoutNode | null>(null);
  const syncing = useRef(false);
  const live = useRef({ active, onFocus, title });
  live.current = { active, onFocus, title };
  useLayoutEffect(() => {
    syncing.current = true;
    try {
      if (pushed.current !== tree) {
        pushed.current = tree;
        store.setRoot(tree);
      }
      store.focusPane(active);
    } finally {
      syncing.current = false;
    }
  }, [store, tree, active]);
  // The engine's live region counts "1 panes" (upstream, not edited here): its text node is said right, in place, so
  // the engine's next count still lands in it.
  useEffect(() => {
    const region = document.querySelector('.ib-layout > .pierre-layout-sr');
    if (!region || typeof MutationObserver === 'undefined') return;
    const say = () => {
      const text = region.firstChild;
      if (text?.nodeType === Node.TEXT_NODE && text.nodeValue === '1 panes') text.nodeValue = '1 pane';
    };
    say();
    const observer = new MutationObserver(say);
    observer.observe(region, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  // A press or focus in a pane (the engine's own handlers) makes it the active one.
  useEffect(
    () =>
      store.subscribe(() => {
        if (syncing.current) return;
        const focused = store.getSnapshot().focusedPane;
        if (focused !== live.current.active) live.current.onFocus(focused);
      }),
    [store],
  );
  return (
    <Layout
      store={store}
      className="ib-layout"
      gap={gap}
      label="Threads"
      renderPane={renderPane}
      renderHeader={noHeader}
      paneActions={NO_ACTIONS}
      getPaneTitle={(pane) => live.current.title(pane.id)}
      getPaneProps={(pane) => ({ tabIndex: -1, 'data-pane-quiet': pane.id === active ? undefined : '' })}
      onResize={onResize}
    />
  );
}
