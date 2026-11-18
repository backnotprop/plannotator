import { useRef, useState } from 'react';
import type { InboxPullStack, InboxReviewChanges, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { localReviewMessage } from '../compose/reviewBox';
import { guideRequestTarget } from '../guideRequest';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { newUuid } from '../uuid';
import { handoffKeys, pullHandoffAskLine } from './model';

export type ShowMeSubject =
  | { kind: 'pull'; stack: InboxPullStack; linkThreadId: string }
  | { kind: 'local'; changes: InboxReviewChanges; project: string | null; branch: string | null; base: string | null };

export interface ShowMePageInThread {
  message_id: string;
  attachment_id: string;
  title: string;
}

export function showMeWords(subject: ShowMeSubject): string {
  return subject.kind === 'pull'
    ? pullHandoffAskLine(subject.stack, { kind: 'show_me' }).replace(/^1\. /, '')
    : localReviewMessage({ changes: subject.changes, project: subject.project, branch: subject.branch, base: subject.base, words: '', ask: 'show_me' });
}

export function latestShowMePage(thread: InboxThread): ShowMePageInThread | null {
  const message = [...thread.messages].reverse().find((m) => m.author.kind === 'agent' && !!m.show_me);
  return message?.show_me ? { message_id: message.id, ...message.show_me } : null;
}

export function showMeAsked(thread: InboxThread, subject: ShowMeSubject): boolean {
  const words = showMeWords(subject);
  const page = latestShowMePage(thread);
  const after = page ? thread.messages.findIndex((m) => m.id === page.message_id) + 1 : 0;
  return thread.messages.slice(after).some((m) => m.author.kind === 'person' && m.body.trimStart().startsWith(words));
}

export const SHOW_ME_NOT_SENT = 'The Show me request was not sent.';
export const SHOW_ME_UNTOLD = 'Asked for a Show me page, but this pull request doesn’t say so yet. Press Show me again.';

const requests = new Map<string, { key: string; sent: boolean }>();
export const forgetShowMeRequests = () => requests.clear();

export function useShowMeAsk(
  subject: ShowMeSubject,
  thread: InboxThread,
  onAsked?: () => void,
): { page: ShowMePageInThread | null; onShowMe: (() => void) | null; onTheWay: boolean; error: string | null } {
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [askedOver, setAskedOver] = useState<string | null | undefined>(undefined);
  const page = latestShowMePage(thread);
  const untold = requests.get(thread.thread_id)?.sent === true;
  const onTheWay = !untold && (askedOver === (page?.message_id ?? null) || showMeAsked(thread, subject));
  if (onTheWay) return { page, onShowMe: null, onTheWay: true, error: null };
  const target = guideRequestTarget(thread);
  if (!target || (subject.kind === 'pull' && subject.linkThreadId !== thread.thread_id)) return { page, onShowMe: null, onTheWay: false, error };
  const ask = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const request = requests.get(thread.thread_id) ?? { key: newUuid(), sent: false };
    requests.set(thread.thread_id, request);
    try {
      if (!request.sent) {
        const words = showMeWords(subject);
        const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE);
        await inboxApi.reply(target.message.id, { idempotency_key: request.key, words: withSkillsBlock(words, skills), questions: [] });
        request.sent = true;
      }
    } catch (cause) {
      setError(`${SHOW_ME_NOT_SENT} ${cause instanceof Error && cause.message ? cause.message : 'Try again.'}`);
      busy.current = false;
      return;
    }
    try {
      if (subject.kind === 'pull') await inboxApi.pullOwner(handoffKeys(subject.stack), thread.thread_id, 'show_me');
      requests.delete(thread.thread_id);
      setAskedOver(page?.message_id ?? null);
      onAsked?.();
    } catch {
      setError(SHOW_ME_UNTOLD);
    } finally {
      busy.current = false;
    }
  };
  return { page, onShowMe: () => void ask(), onTheWay: false, error };
}
