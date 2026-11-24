/**
 * Decision mode's way out to the thread and back (approval "inbox-decide-thread-only"): a card's "Open the thread"
 * or a file tucks the dialog into its pill with the thread behind it, and what goes wrong while the dialog is away
 * is said in the window's toast, the thread one press away.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { InboxToastModel } from '../components/Toast';
import type { FileRef } from '../fileRefs';
import type { DecisionAwayNotice } from '../decisions/DecisionMode';
import type { Route } from './route';
import type { DecideSitting } from './useDecideSitting';
import { writeRoute } from './writeRoute';

export interface DecideTuckDeps {
  setDecide: Dispatch<SetStateAction<DecideSitting | null>>;
  routeRef: { current: Route };
  decideLanding: { current: { messageId: string; questionKey: string } | null };
  searchLanding: { current: unknown };
}

/** The dialog tucks into its pill and the thread opens behind it: on a question, an attached file, or a named file. */
export function tuckDecide(deps: DecideTuckDeps, threadId: string, fileId?: string | (FileRef & { messageId: string }), question?: { messageId: string; key: string }): void {
  deps.setDecide((current) => (current ? { ...current, tucked: true, file: fileId !== undefined } : current));
  if (question && !fileId) {
    // A card's "Open the thread": the dialog closes into its pill and the thread (already behind it) lands on that
    // question, its prompt focused. The same thread replaces the entry, as a search result's landing does, so Back
    // never stops on the same thread twice.
    deps.decideLanding.current = { messageId: question.messageId, questionKey: question.key };
    deps.searchLanding.current = null;
    const now = deps.routeRef.current;
    const same = now.page === 'inbox' && now.thread === threadId && !now.file && !now.guide;
    writeRoute({ page: 'inbox', project: same ? now.project : null, thread: threadId, msg: question.messageId }, same ? { replace: true } : {});
    return;
  }
  writeRoute({ page: 'inbox', project: null, thread: threadId, file: typeof fileId === 'string' ? { id: fileId, version: 'current', focus: null } : null, ...(fileId && typeof fileId !== 'string' ? { ref: fileId } : {}) });
}

/**
 * The toast for a sitting the window no longer shows: a Send that failed after the dialog closed (its answers wait as
 * drafts in the thread), or an answer or a Can't do it's reason whose save failed then (the thread line's own words).
 */
export function decideAwayToast(notice: DecisionAwayNotice): Omit<InboxToastModel, 'id'> {
  const subject = notice.subject ?? 'this thread';
  const lead =
    notice.kind === 'send'
      ? 'A reply was not sent. Your answers wait as drafts in the thread.'
      : notice.kind === 'reason'
        ? `Reason not saved. Your reason in "${subject}" did not reach the Inbox.`
        : `Pick not saved. Your answer in "${subject}" did not reach the Inbox.`;
  return { icon: 'warn', lead, wrap: true, action: { label: 'Open the thread', onPress: () => writeRoute({ page: 'inbox', project: null, thread: notice.threadId }) } };
}
