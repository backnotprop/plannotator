import type { Dispatch, SetStateAction } from 'react';
import type { InboxListRow, InboxListSection, InboxPriorityBefore } from '@plannotator/core/inbox-types';
import { inboxApi, type ListModel } from './api';
import { drawnSection, listGroups, putRowBack, replaceHeldRow, settleThread } from './held';
import { priorityBackIn } from './priority';
import type { InboxToastModel } from './components/Toast';

interface PriorityHost {
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
}

export function priorityWrites({ rowOf, threadRow, showError, showToast, dismissToast, afterWrite, say, armSlide, setShown, shownRef, routeRef, latestRef, listCovered }: PriorityHost) {
  const setPriority = async (row: Pick<InboxListRow, 'thread_id' | 'subject'>, on: boolean) => {
    const threadId = row.thread_id;
    const subject = row.subject ?? '(no subject)';
    const backIn = priorityBackIn(rowOf(threadId) ?? (threadRow()?.thread_id === threadId ? threadRow() : null));
    let before: InboxPriorityBefore;
    try {
      ({ before } = await inboxApi.priority(threadId, on));
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
    const drawnBefore = movePriorityRow(threadId);
    if (on) {
      showToast({
        icon: 'check',
        lead: 'Added to Priority',
        detail: `“${subject}”`,
        speech: `Added “${subject}” to Priority.`,
        onUndo: () => void undoPriority(threadId, before, drawnBefore, 'Removed from Priority again.'),
      });
      return;
    }
    showToast({
      icon: 'check',
      lead: 'Removed from Priority',
      ...(backIn ? { detail: backIn } : {}),
      speech: `Removed “${subject}” from Priority.${backIn ? ` ${backIn}.` : ''}`,
      onUndo: () => void undoPriority(threadId, before, drawnBefore, 'Back in Priority.'),
    });
  };
  const movePriorityRow = (threadId: string): InboxListSection[] | null => {
    const drawn = shownRef.current;
    if ((routeRef.current.thread && listCovered()) || !drawn || !latestRef.current || drawnSection(drawn, threadId) === null) return null;
    const groups = listGroups(latestRef.current);
    if (drawnSection(drawn, threadId) === drawnSection(groups, threadId)) return null;
    armSlide();
    setShown((current) => (current ? settleThread(current, groups, threadId) : current));
    return drawn;
  };
  const undoPriority = async (threadId: string, before: InboxPriorityBefore, drawnBefore: InboxListSection[] | null, words: string) => {
    dismissToast();
    try {
      await inboxApi.priority(threadId, { restore: before });
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
    const now = rowOf(threadId);
    if (drawnBefore && now && !(routeRef.current.thread && listCovered()) && drawnSection(drawnBefore, threadId) !== null) {
      armSlide();
      setShown((current) => (current ? putRowBack(replaceHeldRow(current, now), drawnBefore, threadId) : current));
    } else movePriorityRow(threadId);
    say(words);
  };
  const restorePriority = async (threadId: string, priority: InboxListRow['priority']) => {
    if (!priority?.person) return;
    try {
      await inboxApi.priority(threadId, { restore: { at: priority.at, off_at: null } });
    } catch (cause) {
      showError(cause);
      return;
    }
    await afterWrite([threadId]);
    movePriorityRow(threadId);
  };
  return { setPriority, restorePriority };
}
