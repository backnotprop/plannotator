/**
 * "Back from snooze" (snoozeBack.ts) for the open thread, the look a return under an open thread waits for, and the
 * list read at the nearest snooze's return. `seen` posts the look (App passes the Inbox's).
 */
import { useEffect, useState } from 'react';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';
import { inboxSnoozeDelay } from '@plannotator/core/inbox-snooze';
import type { ListModel } from '../api';
import { pageInFront } from '../sound';
import { snoozeBackAfter, type SnoozeBack } from '../snoozeBack';
import type { Route } from './route';

export function useSnoozeBack({
  thread,
  route,
  listedOpenRow,
  looking,
  openThreadCovered,
  lookRef,
  trackLook,
  refreshList,
  snoozed,
  refreshSnoozes,
  seen,
}: {
  thread: InboxThread | null;
  route: Route;
  listedOpenRow: InboxListRow | null;
  looking: ReadonlySet<string>;
  openThreadCovered: boolean;
  lookRef: { readonly current: { threadId: string; through: number | null } | null };
  trackLook: (threadId: string, look: Promise<unknown>) => void;
  refreshList: (adopt: boolean) => Promise<unknown>;
  snoozed: ListModel['snoozed'];
  refreshSnoozes: () => Promise<unknown>;
  seen: (threadId: string, through: number | null) => Promise<unknown>;
}): SnoozeBack | null {
  // "Back from snooze" (snoozeBack.ts): set while rendering, so the thread's first draw has the line and can open at it.
  const openThreadId = thread && thread.thread_id === route.thread ? thread.thread_id : null;
  const [keptBack, setKeptBack] = useState<SnoozeBack | null>(null);
  const snoozeBack = snoozeBackAfter(keptBack, openThreadId, listedOpenRow);
  if (snoozeBack !== keptBack) setKeptBack(snoozeBack);
  // The return under a thread already open (the opening look is on its way otherwise): the look comes once the window
  // is in front and nothing covers the thread (seen on sight's rule), so until then the row keeps its clock.
  const backUnderOpen = openThreadId && listedOpenRow?.snooze_back && !looking.has(openThreadId) && !openThreadCovered ? openThreadId : null;
  useEffect(() => {
    if (!backUnderOpen) return;
    let taken = false;
    const take = () => {
      if (taken || !pageInFront()) return;
      taken = true;
      // Up to what this window has looked at: a message waiting below the view stays unseen (seenOnSight.ts).
      const through = lookRef.current?.threadId === backUnderOpen ? lookRef.current.through : null;
      trackLook(
        backUnderOpen,
        seen(backUnderOpen, through)
          .then(() => refreshList(false))
          .catch(() => {
            taken = false;
          }),
      );
    };
    take();
    window.addEventListener('focus', take);
    document.addEventListener('visibilitychange', take);
    return () => {
      window.removeEventListener('focus', take);
      document.removeEventListener('visibilitychange', take);
    };
  }, [backUnderOpen, refreshList, trackLook]);
  // The list reads again at the nearest return, by this window's clock (api.ts runs the rule on what it reads): a
  // linked machine asleep past a thread's time sends no event, and the row still comes back.
  useEffect(() => {
    const delay = inboxSnoozeDelay((snoozed ?? []).flatMap((row) => (row.snoozed ? [row.snoozed.until] : [])));
    if (delay === null) return;
    const timer = setTimeout(() => void refreshSnoozes(), delay);
    return () => clearTimeout(timer);
  }, [snoozed, refreshSnoozes]);
  return snoozeBack;
}
