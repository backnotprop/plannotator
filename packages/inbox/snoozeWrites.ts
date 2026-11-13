import type { Dispatch, SetStateAction } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxSnoozeRunning, inboxSnoozeWhen, type InboxRowSnooze } from '@plannotator/core/inbox-snooze';
import { InboxApiError, inboxApi, type ListModel } from './api';
import { drawnSection, listGroups, putRowBack, replaceHeldRow, settleThread } from './held';
import type { InboxToastModel } from './components/Toast';

interface SnoozeHost {
  rowOf: (threadId: string) => InboxListRow | undefined;
  threadRow: () => InboxListRow | null;
  showError: (cause: unknown) => void;
  showToast: (toast: Omit<InboxToastModel, 'id'>) => void;
  dismissToast: () => void;
  afterWrite: (written?: readonly string[]) => Promise<unknown>;
  say: (text: string) => void;
  armSlide: () => void;
  setShown: Dispatch<SetStateAction<InboxListSection[] | null>>;
  shownRef: { readonly current: InboxListSection[] | null };
  routeRef: { readonly current: { thread?: string | null } };
  latestRef: { readonly current: ListModel | null };
  listCovered: () => boolean;
  snoozeMoved: { readonly current: Map<string, InboxListSection[]> };
  snoozedThisLoad: { current: boolean };
}

export function snoozeWrites({ rowOf, threadRow, showError, showToast, dismissToast, afterWrite, say, armSlide, setShown, shownRef, routeRef, latestRef, listCovered, snoozeMoved, snoozedThisLoad }: SnoozeHost) {
  const restoreSnooze = async (threadId: string, snooze: InboxRowSnooze | null | undefined) => {
    if (!snooze || !inboxSnoozeRunning(snooze.until)) return;
    try {
      await inboxApi.snooze(threadId, snooze.until, snooze.at);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
  };
  const snooze = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>, until: string) => {
    const threadId = row.thread_id;
    const earlier = (rowOf(threadId) ?? (threadRow()?.thread_id === threadId ? threadRow() : null))?.snoozed ?? null;
    snoozedThisLoad.current = true;
    let answer: Awaited<ReturnType<typeof inboxApi.snooze>>;
    try {
      answer = await inboxApi.snooze(threadId, until);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    if (answer.snoozed === null) {
      showError(new InboxApiError(409, 'snooze_past', 'That time has passed.'));
      return;
    }
    const drawnBefore = moveSnoozedRow(threadId);
    if (drawnBefore) snoozeMoved.current.set(threadId, drawnBefore);
    const when = inboxSnoozeWhen(until);
    showToast({
      icon: 'clock',
      lead: 'Snoozed',
      detail: when,
      speech: `Snoozed “${row.subject ?? '(no subject)'}” until ${when}.`,
      onUndo: () => void putSnooze(threadId, earlier, drawnBefore),
    });
  };
  const moveSnoozedRow = (threadId: string): InboxListSection[] | null => {
    const drawn = shownRef.current;
    if ((routeRef.current.thread && listCovered()) || !drawn || !latestRef.current) return null;
    if (drawnSection(drawn, threadId) === null || !rowOf(threadId)?.snoozed) return null;
    const groups = listGroups(latestRef.current);
    armSlide();
    setShown((current) => (current ? settleThread(current, groups, threadId) : current));
    return drawn;
  };
  const putSnooze = async (threadId: string, earlier: InboxRowSnooze | null, drawnBefore: InboxListSection[] | null = null) => {
    snoozeMoved.current.delete(threadId);
    try {
      await inboxApi.snooze(threadId, earlier && inboxSnoozeRunning(earlier.until) ? earlier.until : null, earlier?.at);
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite();
    putSnoozedRowBack(threadId, drawnBefore);
    dismissToast();
    say(earlier ? 'Snooze moved back.' : 'Unsnoozed.');
  };
  const putSnoozedRowBack = (threadId: string, drawnBefore: InboxListSection[] | null) => {
    const now = rowOf(threadId);
    if (!drawnBefore || !now || (routeRef.current.thread && listCovered()) || drawnSection(shownRef.current, threadId) !== 'snoozed') return;
    armSlide();
    setShown((current) => (current ? (now.snoozed ? settleThread(current, listGroups(latestRef.current!), threadId) : putRowBack(replaceHeldRow(current, now), drawnBefore, threadId)) : current));
  };
  const moveRowAlone = (threadId: string): boolean => {
    if (!latestRef.current || drawnSection(shownRef.current, threadId) === null) return false;
    const groups = listGroups(latestRef.current);
    armSlide();
    setShown((current) => (current ? settleThread(current, groups, threadId) : current));
    return true;
  };
  const unsnooze = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>) => {
    const threadId = row.thread_id;
    const earlier = (rowOf(threadId) ?? (threadRow()?.thread_id === threadId ? threadRow() : null))?.snoozed ?? null;
    const drawnBefore = snoozeMoved.current.get(threadId) ?? null;
    try {
      await inboxApi.snooze(threadId, null);
    } catch (cause) {
      showError(cause);
      return;
    }
    snoozeMoved.current.delete(threadId);
    await afterWrite([threadId]);
    putSnoozedRowBack(threadId, drawnBefore);
    const cameBack = !drawnBefore && !routeRef.current.thread && moveRowAlone(threadId);
    showToast({
      icon: 'clock',
      lead: 'Unsnoozed',
      speech: `Unsnoozed “${row.subject ?? '(no subject)'}”.`,
      onUndo: earlier
        ? () => {
            dismissToast();
            void restoreSnooze(threadId, earlier).then(() => {
              if (!drawnBefore && !cameBack) return;
              const moved = moveSnoozedRow(threadId);
              if (moved) snoozeMoved.current.set(threadId, moved);
            });
          }
        : undefined,
    });
  };
  return { snooze, unsnooze, restoreSnooze };
}

