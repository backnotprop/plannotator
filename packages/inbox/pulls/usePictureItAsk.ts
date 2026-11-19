import { useRef, useState } from 'react';
import type { InboxPullStack, InboxReviewChanges, InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { localReviewMessage } from '../compose/reviewBox';
import { guideRequestTarget } from '../guideRequest';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { newUuid } from '../uuid';
import { handoffKeys, pullHandoffAskLine } from './model';

export type PictureItSubject =
  | { kind: 'pull'; stack: InboxPullStack; linkThreadId: string }
  | { kind: 'local'; changes: InboxReviewChanges; project: string | null; branch: string | null; base: string | null };

export interface PictureItPageInThread {
  message_id: string;
  attachment_id: string;
  title: string;
}

export function pictureItWords(subject: PictureItSubject): string {
  return subject.kind === 'pull'
    ? pullHandoffAskLine(subject.stack, { kind: 'picture_it' }).replace(/^1\. /, '')
    : localReviewMessage({ changes: subject.changes, project: subject.project, branch: subject.branch, base: subject.base, words: '', ask: 'picture_it' });
}

export function latestPictureItPage(thread: InboxThread): PictureItPageInThread | null {
  const message = [...thread.messages].reverse().find((m) => m.author.kind === 'agent' && !!m.picture_it);
  return message?.picture_it ? { message_id: message.id, ...message.picture_it } : null;
}

export function pictureItAsked(thread: InboxThread, subject: PictureItSubject): boolean {
  const words = pictureItWords(subject);
  const page = latestPictureItPage(thread);
  const after = page ? thread.messages.findIndex((m) => m.id === page.message_id) + 1 : 0;
  return thread.messages.slice(after).some((m) => m.author.kind === 'person' && m.body.trimStart().startsWith(words));
}

export const PICTURE_IT_NOT_SENT = 'The Picture it request was not sent.';
export const PICTURE_IT_UNTOLD = 'Asked for a Picture page, but this pull request doesn’t say so yet. Press Picture it again.';

const requests = new Map<string, { key: string; sent: boolean }>();
export const forgetPictureItRequests = () => requests.clear();

export function usePictureItAsk(
  subject: PictureItSubject,
  thread: InboxThread,
  onAsked?: () => void,
): { page: PictureItPageInThread | null; onPictureIt: (() => void) | null; onTheWay: boolean; error: string | null } {
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [askedOver, setAskedOver] = useState<string | null | undefined>(undefined);
  const page = latestPictureItPage(thread);
  const untold = requests.get(thread.thread_id)?.sent === true;
  const onTheWay = !untold && (askedOver === (page?.message_id ?? null) || pictureItAsked(thread, subject));
  if (onTheWay) return { page, onPictureIt: null, onTheWay: true, error: null };
  const target = guideRequestTarget(thread);
  if (!target || (subject.kind === 'pull' && subject.linkThreadId !== thread.thread_id)) return { page, onPictureIt: null, onTheWay: false, error };
  const ask = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const request = requests.get(thread.thread_id) ?? { key: newUuid(), sent: false };
    requests.set(thread.thread_id, request);
    try {
      if (!request.sent) {
        const words = pictureItWords(subject);
        const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE);
        await inboxApi.reply(target.message.id, { idempotency_key: request.key, words: withSkillsBlock(words, skills), questions: [] });
        request.sent = true;
      }
    } catch (cause) {
      setError(`${PICTURE_IT_NOT_SENT} ${cause instanceof Error && cause.message ? cause.message : 'Try again.'}`);
      busy.current = false;
      return;
    }
    try {
      if (subject.kind === 'pull') await inboxApi.pullOwner(handoffKeys(subject.stack), thread.thread_id, 'picture_it');
      requests.delete(thread.thread_id);
      setAskedOver(page?.message_id ?? null);
      onAsked?.();
    } catch {
      setError(PICTURE_IT_UNTOLD);
    } finally {
      busy.current = false;
    }
  };
  return { page, onPictureIt: () => void ask(), onTheWay: false, error };
}
