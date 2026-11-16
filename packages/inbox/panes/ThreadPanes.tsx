import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Edge, PaneNode } from '@plannotator/vendor-pierre-layouts';
import type { HeldThread } from '../data/apply/record';
import { useHeldThread } from '../data/queries/thread';
import { announce } from '../drag/threadDrag';
import { ThreadSlot } from '../thread/ThreadSlot';
import type { ThreadSlotHost } from '../thread/slotHost';
import FreeLayout from './FreeLayout';
import * as L from './layoutModel';
import { drawnTree, fits, hiddenForRoom, neighbor } from './layoutRoom';
import { measureRoom, usePaneDrop } from './paneDrop';
import { liveHost, quietDigest, quietHost, sameDigest, withPaneClose, type ThreadPanesHost } from './paneHosts';
import { PaneMenuContext, type PaneMenu } from './PaneMenu';
import type { WindowPanes } from './useRoutePanes';

export { paneRoute } from './paneHosts';

export interface ThreadPanesProps {
  windowPanes: WindowPanes;
  /** The active pane's thread as App holds it (`useHeldThread`); every other pane's slot reads its own. */
  held: HeldThread | null;
  host: ThreadPanesHost;
}

/** What every pane draws from: the window's latest, through context, so the engine's pane bodies need no new `renderPane`. */
interface PanesView {
  windowPanes: WindowPanes;
  held: HeldThread | null;
  host: ThreadPanesHost;
  hidden: ReadonlySet<L.PaneId>;
  /** More than one pane shows. */
  multi: boolean;
  first: L.PaneId | null;
}

const PanesViewContext = createContext<PanesView | null>(null);

/** The subject a pane's thread has, for its name and a drag's pill. */
function titleOf(host: ThreadPanesHost, thread: string | undefined): string {
  return (thread && host.rowOf(thread)?.subject) || 'Thread';
}

/**
 * The thread panes after the list. Without the switch, and on a phone, in a stacked window, with a card or Reviews'
 * thread open or a file full screen, the active pane draws exactly today's slot. Otherwise the panes draw in the free
 * layout (FreeLayout.tsx), even one, so a pane never mounts again when another opens, moves or closes: it keeps its
 * scroll and its reply box. A file open beside the active pane takes the others' room (they step aside, in place).
 * Only the active pane draws with every change of the window; the others draw when what they show changes
 * (paneHosts.ts).
 */
export function ThreadPanes({ windowPanes, held, host }: ThreadPanesProps) {
  const { panes, layout } = windowPanes;
  const { route } = host;
  const engine = windowPanes.allowed && !host.phone && !host.stack.thread && !host.fromCard && route.page === 'inbox' && !route.reviews && !route.full && !!layout.root;
  const roomHidden = useRoomHidden(layout, engine && !host.fileOpen);
  const hidden = useMemo(() => (engine && host.fileOpen ? new Set(L.panesOf(layout.root).map((pane) => pane.id).filter((id) => id !== layout.active)) : roomHidden), [engine, host.fileOpen, layout, roomHidden]);
  const multi = engine && L.panesOf(layout.root).length - hidden.size > 1;
  const title = useCallback((id: L.PaneId) => titleOf(host, windowPanes.layout.threads[id]), [host, windowPanes]);
  usePaneDrop({ enabled: engine && !host.fileOpen, multi, windowPanes, hidden, title, holdSidebar: (columns) => host.holdSidebarIfTight(columns) });
  const gone = useCallback((thread: string) => windowPanes.closeThreads([thread]), [windowPanes]);
  const watch = L.paneCount(layout) > 1 && host.route.page === 'inbox';
  const watches = watch ? panes.panes.map((pane) => pane.thread && <GoneWatch key={pane.id} paneId={pane.id} threadId={pane.thread} restored={windowPanes.restored.has(pane.id)} host={host} onGone={gone} />) : null;
  const view = { windowPanes, held, host, hidden, multi, first: L.firstPane(layout.root) };
  const renderPane = useCallback((pane: PaneNode) => <PaneSlot paneId={pane.id} />, []);
  const tree = useMemoTree(layout.root, hidden);
  if (!engine) {
    const pane = panes.panes.find((entry) => entry.id === panes.active) ?? panes.panes[0]!;
    return (
      <>
        {watches}
        <ThreadSlot key={pane.id} paneId={pane.id} threadId={pane.thread} active held={held} host={host} />
      </>
    );
  }
  const gap = measureRoom()?.gap ?? 1;
  return (
    <PanesViewContext.Provider value={view}>
      {watches}
      <FreeLayout
        tree={tree!}
        active={layout.active!}
        gap={gap}
        title={title}
        renderPane={renderPane}
        onFocus={windowPanes.focus}
        onResize={windowPanes.resized}
      />
    </PanesViewContext.Provider>
  );
}

/** The drawn tree, the same object while the layout and what stepped aside are the same (the engine is pushed only on change). */
function useMemoTree(root: L.FreeLayout['root'], hidden: ReadonlySet<L.PaneId>) {
  // `hidden` is the same set while its members are (useRoomHidden).
  return useMemo(() => (root ? drawnTree(root, hidden) : null), [root, hidden]);
}

/**
 * The panes that step aside for room (layoutRoom.ts), worked out again when the window, the sidebar or the list
 * changes size; the window draws again only when the set changes, not for every pixel of a resize.
 */
function useRoomHidden(layout: L.FreeLayout, on: boolean): ReadonlySet<L.PaneId> {
  const [key, setKey] = useState('');
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const measure = useCallback(() => {
    const measured = on ? measureRoom() : null;
    const next = measured ? [...hiddenForRoom(layoutRef.current, measured.room, measured.gap)].sort().join('\u0000') : '';
    setKey((current) => (current === next ? current : next));
  }, [on]);
  useLayoutEffect(measure, [measure, layout]);
  useEffect(() => {
    if (!on) return;
    const main = document.querySelector('.pn-inbox .ib-main');
    const root = document.querySelector('.pn-inbox');
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    for (const el of [root, main, main?.querySelector(':scope > .ib-listcol'), root?.querySelector('.ib-sb-inner')]) if (el && observer) observer.observe(el);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [on, measure]);
  return useMemo(() => new Set(key ? key.split('\u0000') : []), [key]);
}

/** One pane in the free layout: the active one draws with the window; any other draws when what it shows changes. */
function PaneSlot({ paneId }: { paneId: L.PaneId }) {
  const view = useContext(PanesViewContext)!;
  const { windowPanes, host, held, hidden, multi, first } = view;
  const { layout } = windowPanes;
  const thread = layout.threads[paneId] ?? null;
  const active = paneId === layout.active;
  const isFirst = paneId === first;
  const menu = useMemo<PaneMenu>(
    () => ({
      moves: () => paneMoves(windowPanes, paneId),
      move: (edge) => moveBeside(windowPanes, paneId, edge),
      close: () => windowPanes.closePane(paneId),
    }),
    [windowPanes, paneId],
  );
  const base = active ? host : quietHost(host, thread);
  // The only pane on screen is today's one thread: its ✕ closes the thread, and its menu has no pane actions.
  const own = multi ? withPaneClose(base, paneId, windowPanes.closePane, isFirst) : base;
  const ref = useRef<ThreadSlotHost>(own);
  ref.current = own;
  if (hidden.has(paneId) || thread === null) return null;
  return (
    <PaneMenuContext.Provider value={multi ? menu : null}>
      <PaneBody paneId={paneId} threadId={thread} active={active} held={held} hostRef={ref} digest={active ? null : quietDigest(own, paneId, thread)} />
    </PaneMenuContext.Provider>
  );
}

interface PaneBodyProps {
  paneId: L.PaneId;
  threadId: string;
  active: boolean;
  /** The active pane's thread as App holds it; any other pane reads its own. */
  held: HeldThread | null;
  hostRef: RefObject<ThreadSlotHost>;
  /** What the pane draws from the window when it is not the active one (null: it is). */
  digest: readonly unknown[] | null;
}

/** A pane's slot, the same component whether it is the active pane or not, so it never mounts again when that changes. */
const PaneBody = memo(
  function PaneBody({ paneId, threadId, active, held, hostRef }: PaneBodyProps) {
    const live = useMemo(() => liveHost(hostRef), [hostRef]);
    // A pane that is not the active one showed its thread already: what the cache holds stays drawn while it re-reads.
    const own = useHeldThread(active ? null : threadId, true);
    return <ThreadSlot paneId={paneId} threadId={threadId} active={active} held={active ? held : own} host={active ? hostRef.current! : live} />;
  },
  (a, b) => !a.active && !b.active && a.paneId === b.paneId && a.threadId === b.threadId && !!a.digest && !!b.digest && sameDigest(a.digest, b.digest),
);

/** The panes' boxes on screen, for the ⋯ menu's moves. */
function paneRects() {
  return [...document.querySelectorAll<HTMLElement>('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])')].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.layoutPane!, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

const EDGES: readonly Edge[] = ['left', 'right', 'top', 'bottom'];

/** The sides pane `id` can move to: a pane is there on screen, and the layout fits after the move. */
function paneMoves(windowPanes: WindowPanes, id: L.PaneId): Edge[] {
  const rects = paneRects();
  const measured = measureRoom(true);
  return EDGES.filter((edge) => {
    const next = neighbor(rects, id, edge);
    if (!next) return false;
    const moved = L.move(windowPanes.layout, id, next, edge);
    return moved !== windowPanes.layout && !!moved.root && (!measured || fits(moved.root, measured.room, measured.gap));
  });
}

/** The ⋯ menu's Move: past the neighbour on that side. Focus stays in the pane. */
function moveBeside(windowPanes: WindowPanes, id: L.PaneId, edge: Edge): void {
  const next = neighbor(paneRects(), id, edge);
  if (!next) return;
  windowPanes.movePane(id, next, edge);
  announce(`Pane moved ${edge === 'top' ? 'up' : edge === 'bottom' ? 'down' : edge}.`);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(`.ib-layout > [data-layout-pane="${CSS.escape(id)}"] .ib-tmore`)?.focus({ preventScroll: true }));
}

/**
 * A pane's thread that goes beside other panes closes its pane: one deleted (its read is a 404), one archived while
 * shown (by the person or an agent), or one already archived when a kept layout comes back. A thread opened archived
 * on purpose (from Archived) stays.
 */
function GoneWatch({ paneId, threadId, restored, host, onGone }: { paneId: L.PaneId; threadId: string; restored: boolean; host: ThreadSlotHost; onGone: (thread: string) => void }) {
  const held = useHeldThread(threadId, true);  const load = host.paneReads.view(paneId).load;
  const thread = held?.thread && held.thread.thread_id === threadId ? held.thread : null;
  const archived = !!thread && thread.resolved_at != null;
  const firstSeen = useRef<boolean | null>(null);
  useEffect(() => {
    if (load?.threadId === threadId && load.state === 'missing') return onGone(threadId);
    if (!thread) return;
    if (firstSeen.current === null) {
      firstSeen.current = archived;
      if (archived && restored) onGone(threadId);
    } else if (archived && !firstSeen.current) onGone(threadId);
  });
  return null;
}
