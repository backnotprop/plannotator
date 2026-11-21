import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { Edge, PaneNode } from '@plannotator/vendor-pierre-layouts';
import type { HeldThread } from '../data/apply/record';
import { useHeldThread } from '../data/queries/thread';
import { announce } from './paneDrag';
import { placementKey, roomShrankToast } from './beside';
import { ThreadSlot } from '../thread/ThreadSlot';
import type { ThreadSlotHost } from '../thread/slotHost';
import FreeLayout from './FreeLayout';
import * as L from './layoutModel';
import { drawnTree, fits, hiddenForRoom, neighbor } from './layoutRoom';
import { measureRoom, paneRects, usePaneDrop } from './paneDrop';
import { landAfterPaneClose, liveHost, quietDigest, quietHost, sameDigest, withPaneClose, type ThreadPanesHost } from './paneHosts';
import { createPaneKeeper, PaneDock, PaneKeeperContext } from './paneKeeper';
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
 * The thread panes after the list. Without the switch, the window's one thread draws exactly today's slot.
 *
 * With it, every pane in the layout stays mounted, each in a node of its own (paneKeeper.tsx), and the layout only
 * says where each node shows. Beside the list the panes draw in the free layout (FreeLayout.tsx), even one. On a
 * phone, in a stacked window, with a card's or Reviews' thread open or a file full screen, the active pane shows in
 * today's slot and the others wait off the page. A file open beside the active pane takes the others' room, and a
 * narrow window the least recent's: they wait off the page too, and come back as they were, scroll, folds and reply box
 * included (a recording in one stops as it goes: no mic runs unseen). They read nothing there, and once back read what
 * changed meanwhile (paneReads.ts `park`). Only the active pane draws with every change of the window; the others draw
 * when what they show changes (paneHosts.ts).
 */
export function ThreadPanes({ windowPanes, held, host }: ThreadPanesProps) {
  const { panes, layout } = windowPanes;
  const { route } = host;
  const engine = windowPanes.allowed && !host.phone && !host.stack.thread && !host.fromCard && route.page === 'inbox' && !route.reviews && !route.full && !!layout.root;
  const roomHidden = useRoomHidden(layout, engine && !host.fileOpen, (ids) => host.showToast(roomShrankToast(ids.flatMap((id) => layout.threads[id] ?? []), host.rowOf)));
  const ids = useMemo(() => L.panesOf(layout.root).map((pane) => pane.id), [layout.root]);
  const shownAlone = (panes.panes.find((entry) => entry.id === panes.active) ?? panes.panes[0]!).id;
  // Off the page: beside a file every pane but the active one; in today's one slot, every pane but the one it shows.
  const hidden = useMemo(
    () => (!engine ? new Set(ids.filter((id) => id !== shownAlone)) : host.fileOpen ? new Set(ids.filter((id) => id !== layout.active)) : stillAside(roomHidden, ids, layout.active)),
    [engine, host.fileOpen, ids, layout.active, roomHidden, shownAlone],
  );
  // A pane off the page reads nothing until it is back (paneReads.ts `park`). Without the switch none is.
  useEffect(() => host.paneReads.park(windowPanes.allowed ? hidden : new Set()), [host.paneReads, hidden, windowPanes.allowed]);
  const multi = engine && ids.length - hidden.size > 1;
  const title = useCallback((id: L.PaneId) => titleOf(host, windowPanes.layout.threads[id]), [host, windowPanes]);
  usePaneDrop({ enabled: engine && !host.fileOpen, multi, windowPanes, title, holdSidebar: (columns) => host.holdSidebarIfTight(columns) });
  const [keeper] = useState(createPaneKeeper);
  keeper.live.current = { active: layout.active, onFocus: windowPanes.focus, engine, title };
  const idsKey = ids.join('\u0000');
  // Today's one slot docks `shownAlone` even before a thread is in it (nothing open yet): its node is kept too, or the
  // slot would hold a node forgotten here while the pane's thread draws into a new one off the page.
  useLayoutEffect(() => keeper.keep(new Set([...ids, shownAlone])), [keeper, idsKey, shownAlone]);
  const gone = useCallback((thread: string) => windowPanes.closeThreads([thread]), [windowPanes]);
  const watch = L.paneCount(layout) > 1 && host.route.page === 'inbox';
  const watches = watch
    ? panes.panes.map((pane) => pane.thread && <GoneWatch key={pane.id} paneId={pane.id} threadId={pane.thread} restored={windowPanes.restored.has(pane.id)} host={host} recording={keeper.recording} onGone={gone} />)
    : null;
  const view = { windowPanes, held, host, hidden, multi, first: L.firstPane(layout.root) };
  const tree = useMemoTree(layout.root, hidden);
  if (!windowPanes.allowed) {
    const pane = panes.panes.find((entry) => entry.id === panes.active) ?? panes.panes[0]!;
    return (
      <>
        {watches}
        <ThreadSlot key={pane.id} paneId={pane.id} threadId={pane.thread} active held={held} host={host} />
      </>
    );
  }
  return (
    <PaneKeeperContext.Provider value={keeper}>
      <PanesViewContext.Provider value={view}>
        {watches}
        {ids.map((id) => createPortal(<PaneSlot paneId={id} />, keeper.nodeOf(id), id))}
        {engine ? (
          <FreeLayout tree={tree!} active={layout.active!} gap={measureRoom()?.gap ?? 1} title={title} renderPane={renderDock} onFocus={windowPanes.focus} onResize={windowPanes.resized} />
        ) : (
          <PaneDock paneId={shownAlone} />
        )}
      </PanesViewContext.Provider>
    </PaneKeeperContext.Provider>
  );
}

/**
 * What stepped aside as of the last measure, less the active pane and panes no longer in the layout. The measure runs
 * after the draw, so for one draw after a close (an Undo, a ✕) the set can still name the pane that is now active and
 * alone: drawn hidden, the engine would have no visible pane. The same set while nothing is taken out.
 */
function stillAside(hidden: ReadonlySet<L.PaneId>, ids: readonly L.PaneId[], active: L.PaneId | null): ReadonlySet<L.PaneId> {
  const kept = [...hidden].filter((id) => id !== active && ids.includes(id));
  return kept.length === hidden.size ? hidden : new Set(kept);
}

/** A pane's place in the free layout: its node shows there unless it stepped aside. */
const renderDock = (pane: PaneNode) => <LayoutDock paneId={pane.id} />;

function LayoutDock({ paneId }: { paneId: L.PaneId }) {
  const { hidden } = useContext(PanesViewContext)!;
  return hidden.has(paneId) ? null : <PaneDock paneId={paneId} />;
}

/** The drawn tree, the same object while the layout and what stepped aside are the same (the engine is pushed only on change). */
function useMemoTree(root: L.FreeLayout['root'], hidden: ReadonlySet<L.PaneId>) {
  // `hidden` is the same set while its members are (useRoomHidden).
  return useMemo(() => (root ? drawnTree(root, hidden) : null), [root, hidden]);
}

/** How long the room must stay as it is after a resize before panes it left aside are said (a window edge dragged). */
const ROOM_SETTLE_MS = 400;

/**
 * The panes that step aside for room (layoutRoom.ts), worked out again when the window, the sidebar or the list
 * changes size; the window draws again only when the set changes, not for every pixel of a resize. Panes that step
 * aside because the room shrank (not for a layout change, where "Open to the side" says its own) go to `stepped` once
 * the resize settles, those aside then that were not before it began, so the person is told where they went
 * (beside.ts `roomShrankToast`) instead of seeing them vanish, and a narrowing undone at once says nothing.
 */
function useRoomHidden(layout: L.FreeLayout, on: boolean, stepped: (ids: L.PaneId[]) => void): ReadonlySet<L.PaneId> {
  const [key, setKey] = useState('');
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const keyRef = useRef(key);
  const steppedRef = useRef(stepped);
  steppedRef.current = stepped;
  /** A resize under way: what was aside before it began, and the timer that says what it left aside. */
  const settling = useRef<{ before: ReadonlySet<string>; timer: ReturnType<typeof setTimeout> } | null>(null);
  const measure = useCallback((resized = false) => {
    const measured = on ? measureRoom() : null;
    const ids = measured ? [...hiddenForRoom(layoutRef.current, measured.room, measured.gap)].sort() : [];
    const next = ids.join('\u0000');
    if (!resized && settling.current) {
      clearTimeout(settling.current.timer);
      settling.current = null;
    }
    if (next === keyRef.current) return;
    const was = new Set(keyRef.current ? keyRef.current.split('\u0000') : []);
    keyRef.current = next;
    setKey(next);
    if (!resized) return;
    const before = settling.current?.before ?? was;
    if (settling.current) clearTimeout(settling.current.timer);
    const timer = setTimeout(() => {
      settling.current = null;
      const aside = keyRef.current ? keyRef.current.split('\u0000') : [];
      const added = aside.filter((id) => !before.has(id));
      if (added.length) steppedRef.current(added);
    }, ROOM_SETTLE_MS);
    settling.current = { before, timer };
  }, [on]);
  // A layout whose placement is the same (only sizes: the engine reports them as the window resizes, or a divider
  // moved) is part of the resize, not a change of layout.
  const placed = useRef<{ key: string; on: boolean } | null>(null);
  useLayoutEffect(() => {
    const key = placementKey(layout);
    const same = placed.current?.key === key && placed.current.on === on;
    placed.current = { key, on };
    measure(same);
  }, [measure, layout, on]);
  useEffect(
    () => () => {
      if (settling.current) clearTimeout(settling.current.timer);
      settling.current = null;
    },
    [on],
  );
  useEffect(() => {
    if (!on) return;
    const main = document.querySelector('.pn-inbox .ib-main');
    const root = document.querySelector('.pn-inbox');
    const resized = () => measure(true);
    window.addEventListener('resize', resized);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resized);
    for (const el of [root, main, main?.querySelector(':scope > .ib-listcol'), root?.querySelector('.ib-sb-inner')]) if (el && observer) observer.observe(el);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resized);
    };
  }, [on, measure]);
  return useMemo(() => new Set(key ? key.split('\u0000') : []), [key]);
}

/** One pane, on the page or off it: the active one draws with the window; any other draws when what it shows changes. */
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
      close: () => {
        windowPanes.closePane(paneId);
        landAfterPaneClose();
      },
    }),
    [windowPanes, paneId],
  );
  const base = active ? host : quietHost(host, thread);
  // The only pane on screen is today's one thread: its ✕ closes the thread, and its menu has no pane actions.
  const own = multi ? withPaneClose(base, paneId, windowPanes.closePane, isFirst) : base;
  const ref = useRef<ThreadSlotHost>(own);
  ref.current = own;
  if (thread === null) return null;
  return (
    <PaneMenuContext.Provider value={multi ? menu : null}>
      <PaneBody paneId={paneId} threadId={thread} active={active} shown={!hidden.has(paneId)} held={held} hostRef={ref} digest={active ? null : quietDigest(own, paneId, thread)} />
    </PaneMenuContext.Provider>
  );
}

interface PaneBodyProps {
  paneId: L.PaneId;
  threadId: string;
  active: boolean;
  /** On the page (not waiting off it). */
  shown: boolean;
  /** The active pane's thread as App holds it; any other pane reads its own. */
  held: HeldThread | null;
  hostRef: RefObject<ThreadSlotHost>;
  /** What the pane draws from the window when it is not the active one (null: it is). */
  digest: readonly unknown[] | null;
}

/** A pane's slot, the same component whether it is the active pane or not, so it never mounts again when that changes. */
const PaneBody = memo(
  function PaneBody({ paneId, threadId, active, shown, held, hostRef }: PaneBodyProps) {
    const live = useMemo(() => liveHost(hostRef), [hostRef]);
    // A pane that is not the active one showed its thread already: what the cache holds stays drawn while it re-reads.
    const own = useHeldThread(active ? null : threadId, true);
    return <ThreadSlot paneId={paneId} threadId={threadId} active={active} shown={shown} held={active ? held : own} host={active ? hostRef.current! : live} />;
  },
  (a, b) => !a.active && !b.active && a.paneId === b.paneId && a.threadId === b.threadId && a.shown === b.shown && !!a.digest && !!b.digest && sameDigest(a.digest, b.digest),
);

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
 * on purpose (from Archived) stays. A pane with a recording in progress stays until the recording ends: closing it
 * would cut the person off mid-sentence.
 */
function GoneWatch({ paneId, threadId, restored, host, recording, onGone }: { paneId: L.PaneId; threadId: string; restored: boolean; host: ThreadSlotHost; recording: (id: L.PaneId) => boolean; onGone: (thread: string) => void }) {
  const held = useHeldThread(threadId, true);
  const load = host.paneReads.view(paneId).load;
  const thread = held?.thread && held.thread.thread_id === threadId ? held.thread : null;
  const archived = !!thread && thread.resolved_at != null;
  const firstSeen = useRef<boolean | null>(null);
  const [, recheck] = useState(0);
  useEffect(() => {
    let gone = false;
    if (load?.threadId === threadId && load.state === 'missing') gone = true;
    else if (thread) {
      if (firstSeen.current === null) {
        firstSeen.current = archived;
        gone = archived && restored;
      } else gone = archived && !firstSeen.current;
    }
    if (!gone) return;
    if (!recording(paneId)) return onGone(threadId);
    const timer = setTimeout(() => recheck((n) => n + 1), GONE_RECHECK_MS);
    return () => clearTimeout(timer);
  });
  return null;
}

/** How often a gone thread's pane looks again whether its recording ended. */
const GONE_RECHECK_MS = 500;
