import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChildSize } from '@plannotator/vendor-pierre-layouts';
import type { HeldThread } from '../data/apply/record';
import { useHeldThread } from '../data/queries/thread';
import * as L from './layoutModel';
import { addressThread, paneOf, singlePane, type PaneSet } from './model';
import { usePhone } from '../phone';
import { loadLayout, saveLayout } from './savedLayout';
import { besideLayoutSeen } from './beside';

type PaneId = L.PaneId;

export interface WindowPanes {
  /** The panes the window reads (paneReads.ts): the layout's, or the one pane of a window without the switch. */
  panes: PaneSet;
  /** The free layout: where each pane sits and how big it is (empty without the switch). */
  layout: L.FreeLayout;
  /** The thread columns side by side the layout needs beside the list (sidebarHold.ts). */
  columns: number;
  /** `threadId` opens in a new pane right of the active one, and the person is in it ("Open to the side"). */
  openBeside: (threadId: string) => void;
  /** `threadId` opens in a new pane at `edge` of `target` (a row dropped on a pane's edge). */
  openAt: (threadId: string, target: PaneId, edge: L.Edge) => void;
  /** `threadId` takes pane `target`'s place (a row dropped on a pane's centre). */
  replaceIn: (target: PaneId, threadId: string) => void;
  /** Pane `id` goes to `edge` of pane `target` (a pane dragged by its header, or the ⋯ menu's Move). */
  movePane: (id: PaneId, target: PaneId, edge: L.Edge) => void;
  /** The person closed pane `id` (its ✕, or the ⋯ menu's Close pane). */
  closePane: (id: PaneId) => void;
  /** The panes showing these threads close (archived or deleted while beside others). */
  closeThreads: (threads: readonly string[]) => void;
  /** The person is in pane `id` now (a click or focus in it): the address names its thread. */
  focus: (id: PaneId) => void;
  /** The person dragged a divider: the splits' new sizes. */
  resized: (sizes: Readonly<Record<string, readonly ChildSize[]>>) => void;
  /** Several panes can show: the switch is on and the window is not a phone. */
  allowed: boolean;
  /** The panes that came back from the kept layout (savedLayout.ts) when the window opened. */
  restored: ReadonlySet<PaneId>;
}

const NONE: ReadonlySet<PaneId> = new Set();

/**
 * The window's panes, following the address's thread (`#thread=`, the active pane's thread: layoutModel.ts). Without
 * the switch (config.json `inboxSplitView`), or on a phone, always the one pane a window draws today. `write` puts a
 * thread in the address (`replace`: no new history entry).
 *
 * With the switch, the address and the layout follow each other: a thread the address names shows in the pane that
 * has it or in the active pane; the address closing (Escape, ‹ Inbox) on the Inbox page closes the active pane, and
 * the address then names the pane the person was in before. Another page parks the layout; the Inbox with no thread
 * open (coming back to it, or a reload) brings back a layout of two panes or more, and the address names its active
 * pane's thread again. The layout is kept for the window (savedLayout.ts).
 */
export function useRoutePanes(thread: string | null, onInbox: boolean, switchOn: boolean, write: (thread: string | null, replace: boolean) => void): WindowPanes {
  const phone = usePhone();
  const allowed = switchOn && !phone;
  const held = useRef<L.FreeLayout | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const writeRef = useRef(write);
  writeRef.current = write;
  /** A change the layout made is on its way to the address (`to`), written while it named `from`: not followed back. */
  const ahead = useRef<{ to: string | null; from: string | null } | null>(null);
  /** The last draw was on the Inbox page with the layout in hand: an empty address there closes a pane, not restores. */
  const wasInbox = useRef(false);
  const restored = useRef<ReadonlySet<PaneId>>(NONE);
  /**
   * The address and page the layout last followed. A draw where neither changed follows nothing: closing a pane for an
   * empty address is done once per close, so the draws before the next pane's thread reaches the address (each owes the
   * same write) close no other pane, and the last one left is not dropped as a lone pane.
   */
  const followed = useRef<{ thread: string | null; onInbox: boolean } | null>(null);
  const [, drawn] = useState(0);
  let layout = L.EMPTY_LAYOUT;
  let owed: string | null | undefined;
  if (allowed) {
    if (!held.current) {
      layout = loadLayout();
      restored.current = layout.root ? new Set(Object.keys(layout.threads)) : NONE;
    } else layout = held.current;
    if (ahead.current && (thread === ahead.current.to || thread !== ahead.current.from)) ahead.current = null;
    const moved = !followed.current || followed.current.thread !== thread || followed.current.onInbox !== onInbox;
    followed.current = { thread, onInbox };
    if (!ahead.current && moved) {
      if (thread !== null) layout = L.follow(layout, thread);
      else if (onInbox && wasInbox.current && layout.active) layout = L.close(layout, layout.active);
      else if (onInbox && L.paneCount(layout) < 2) layout = L.EMPTY_LAYOUT;
    }
    held.current = layout;
    wasInbox.current = onInbox;
    const named = L.activeThread(layout);
    owed = ahead.current || !onInbox || named === thread ? undefined : named;
  } else {
    // Off (the switch turned off in any window, or a phone): what this window last followed is forgotten, so the switch
    // coming back on starts from the kept layout (savedLayout.ts), as a reload does, never from an address that moved
    // meanwhile (an Escape with the switch off would otherwise close a pane and open another thread by itself).
    held.current = null;
    followed.current = null;
    wasInbox.current = false;
    ahead.current = null;
  }
  useEffect(() => {
    if (owed !== undefined) writeRef.current(owed, true);
  }, [owed]);
  useEffect(() => {
    if (!allowed) return;
    saveLayout(layout);
    besideLayoutSeen(layout);
  }, [allowed, layout]);
  const commit = useCallback((next: L.FreeLayout, replace: boolean) => {
    if (next === held.current) return;
    held.current = next;
    const to = L.activeThread(next);
    if (to === threadRef.current) {
      drawn((n) => n + 1);
      return;
    }
    ahead.current = { to, from: threadRef.current };
    writeRef.current(to, replace);
  }, []);
  const now = () => held.current ?? L.EMPTY_LAYOUT;
  const openBeside = useCallback((threadId: string) => {
    const at = now();
    commit(at.active ? L.openAt(at, threadId, at.active, 'right') : L.follow(at, threadId), false);
  }, [commit]);
  const openAt = useCallback((threadId: string, target: PaneId, edge: L.Edge) => commit(L.openAt(now(), threadId, target, edge), false), [commit]);
  const replaceIn = useCallback((target: PaneId, threadId: string) => commit(L.replace(now(), target, threadId), false), [commit]);
  const movePane = useCallback((id: PaneId, target: PaneId, edge: L.Edge) => commit(L.move(now(), id, target, edge), true), [commit]);
  const closePane = useCallback((id: PaneId) => commit(L.close(now(), id), false), [commit]);
  const closeThreads = useCallback((threads: readonly string[]) => commit(L.closeWhere(now(), (t) => threads.includes(t)), true), [commit]);
  const focus = useCallback((id: PaneId) => commit(L.focus(now(), id), true), [commit]);
  const resized = useCallback((sizes: Readonly<Record<string, readonly ChildSize[]>>) => commit(L.resize(now(), sizes), true), [commit]);
  // Without the switch, main's one pane: the same set while the address names the same thread.
  const single = useRef<PaneSet | null>(null);
  if (!single.current || addressThread(single.current) !== thread) single.current = singlePane(thread);
  const panes = !allowed ? single.current : onInbox || thread !== null ? L.asPaneSet(layout) : singlePane(null);
  const columns = onInbox ? L.columns(layout.root) : 1;
  return { panes, layout, columns, openBeside, openAt, replaceIn, movePane, closePane, closeThreads, focus, resized, allowed, restored: restored.current };
}

/**
 * The active pane's thread as the cache holds it (`useHeldThread`). Moving into a pane whose thread was already on
 * screen (a click in another pane, or the one beside it closing) keeps it drawn; a thread that was not on screen
 * waits for its fresh read, as opening one always did. Without the switch (`split` false), main's: every opening waits.
 */
export function useActiveHeld(panes: PaneSet, split: boolean): HeldThread | null {
  const before = useRef<PaneSet | null>(null);
  useEffect(() => {
    before.current = panes;
  });
  const thread = addressThread(panes);
  return useHeldThread(thread, split && thread !== null && before.current !== null && paneOf(before.current, thread) !== null);
}
