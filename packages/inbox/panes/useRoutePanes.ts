import { useCallback, useEffect, useRef, useState } from 'react';
import type { HeldThread } from '../data/apply/record';
import { useHeldThread } from '../data/queries/thread';
import { useBesideRoom } from './beside';
import { addressThread, closePane as closeIn, followAddress, paneOf, paneThread, singlePane, split, type PaneId, type PaneSet } from './model';

export interface WindowPanes {
  panes: PaneSet;
  /** `threadId` opens in a second pane beside the active one, and the person is in it. */
  openBeside: (threadId: string) => void;
  /** The person closed pane `id` (its ✕, or leaving full screen from the other one). */
  closePane: (id: PaneId) => void;
  /** The person is in pane `id` now (a click or focus in it): the address names its thread. */
  focus: (id: PaneId) => void;
  /** Two panes can show (the switch is on, and the window has room). */
  allowed: boolean;
}

/**
 * The window's panes, following the address's thread (`#thread=`, the active pane's thread: model.ts). Off (the
 * switch, or no room), always one pane, as before any split. `write` puts a thread in the address (`replace`: no new
 * history entry); a closed address with two panes (on the Inbox page, `onInbox`) closes the active one and names the
 * other's thread.
 */
export function useRoutePanes(thread: string | null, onInbox: boolean, switchOn: boolean, write: (thread: string | null, replace: boolean) => void): WindowPanes {
  const room = useBesideRoom();
  const allowed = switchOn && room;
  const held = useRef<PaneSet | null>(null);
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const writeRef = useRef(write);
  writeRef.current = write;
  /** A change the panes made is on its way to the address (`to`), written while it named `from`: not followed back. */
  const ahead = useRef<{ to: string | null; from: string | null } | null>(null);
  const ids = useRef(0);
  const [, drawn] = useState(0);
  let set = held.current ?? singlePane(thread);
  if (ahead.current && (thread === ahead.current.to || thread !== ahead.current.from)) ahead.current = null;
  // The thread closed (Escape, ‹ Inbox): with two panes, the active one; another page: back to one pane.
  if (!ahead.current && thread === null && set.panes.length > 1) set = onInbox ? closeIn(set, set.active) : singlePane(null);
  else if (!ahead.current) set = followAddress(set, thread);
  if (!allowed && set.panes.length > 1) set = singlePane(addressThread(set));
  held.current = set;
  const owed = ahead.current ? undefined : addressThread(set) === thread ? undefined : addressThread(set);
  useEffect(() => {
    if (owed !== undefined) writeRef.current(owed, true);
  }, [owed]);
  const move = useCallback((next: PaneSet, replace: boolean) => {
    if (next === held.current) return;
    held.current = next;
    const to = addressThread(next);
    if (to === threadRef.current) {
      drawn((n) => n + 1);
      return;
    }
    ahead.current = { to, from: threadRef.current };
    writeRef.current(to, replace);
  }, []);
  const openBeside = useCallback(
    (threadId: string) => {
      const now = held.current!;
      move(split(now, now.active, { id: `beside-${++ids.current}`, thread: threadId }, 'right'), false);
    },
    [move],
  );
  const closePane = useCallback((id: PaneId) => move(closeIn(held.current!, id), false), [move]);
  const focus = useCallback(
    (id: PaneId) => {
      const to = paneThread(held.current!, id);
      if (to !== null && id !== held.current!.active) writeRef.current(to, true);
    },
    [],
  );
  return { panes: set, openBeside, closePane, focus, allowed };
}

/**
 * The active pane's thread as the cache holds it (`useHeldThread`). Moving into a pane whose thread was already on
 * screen (a click in the other pane, or the one beside it closing) keeps it drawn; a thread that was not on screen
 * waits for its fresh read, as opening one always did.
 */
export function useActiveHeld(panes: PaneSet): HeldThread | null {
  const before = useRef(panes);
  useEffect(() => {
    before.current = panes;
  });
  const thread = addressThread(panes);
  return useHeldThread(thread, thread !== null && paneOf(before.current, thread) !== null);
}
