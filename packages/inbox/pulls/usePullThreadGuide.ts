/**
 * Guided review on a PR's thread (one started from its page, mock "V1-5"/"V1-6"): always on the PR's line. Once the
 * agent sent one, it opens the latest. Before that, it asks THIS thread's agent for one, in this thread: the reply
 * route's ordinary reply (as the thread's ⋯ Request guided review sends it, to the same message, `guideRequestTarget`)
 * carrying the hand-off's own step for a guided review (`pullHandoffAskLine`: `/review-curate` on the PR's diff
 * against its base) with its skills block, as New review's hand-off carries them. Then the PR's link says a guided
 * review is on its way (`pulls/owner` with `guide`, this same thread: its `page` mark stays, the server's rule), so
 * the page and Reviews say so. Never a second thread, never a link to another thread.
 *
 * One request per thread: a press while one is on its way does nothing; a request that went but whose link did not
 * change is not sent again (the next press only changes the link); a request that did not go is retried with its key.
 * Kept per thread while the window is open, so leaving and coming back keeps it; after a reload (or from another
 * window) the thread itself says so: a message of the person's in it that is the request (`pullThreadGuideAsked`).
 */
import { useRef, useState } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { guideRequestTarget } from '../guideRequest';
import { INBOX_REPLY_SKILL_AUDIENCE, inboxSkillsBlock, withSkillsBlock } from '../skills';
import { newUuid } from '../uuid';
import { handoffKeys, pullHandoffAskLine } from './model';
import type { ReviewView } from './reviewsModel';

/** The request's words: the hand-off's guided review step, as one message (no step number). */
export function pullThreadGuideWords(stack: NonNullable<ReviewView['pullLine']>['stack']): string {
  return pullHandoffAskLine(stack, { kind: 'guide' }).replace(/^1\. /, '');
}

/** Whether the thread already holds the request (the person's own message with its words): it is not sent again. */
export function pullThreadGuideAsked(thread: InboxThread, stack: NonNullable<ReviewView['pullLine']>['stack'], after: string | null = null): boolean {
  const words = pullThreadGuideWords(stack);
  const from = after ? thread.messages.findIndex((message) => message.id === after) + 1 : 0;
  return thread.messages.slice(from).some((message) => message.author.kind === 'person' && message.body.trimStart().startsWith(words));
}

/** The request did not go. */
export const PULL_GUIDE_NOT_SENT = 'The guided review request was not sent.';
/** It went, but the PR's link still says nothing asked. */
export const PULL_GUIDE_UNTOLD = 'Asked for a guided review, but this pull request doesn’t say so yet. Press Guided review again.';

/** Per thread: the request's key, and whether it went. */
const requests = new Map<string, { key: string; sent: boolean }>();
/** For the tests. */
export const forgetPullGuideRequests = () => requests.clear();

export function usePullThreadGuide(
  line: NonNullable<ReviewView['pullLine']>,
  thread: InboxThread,
  onOpenGuide: (messageId: string) => void,
  again = false,
): { onGuide: (() => void) | null; onTheWay: boolean; error: string | null } {
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [askedOver, setAskedOver] = useState<string | null | undefined>(undefined);
  const guide = [...thread.messages].reverse().find((message) => !!message.guide);
  if (guide && !again) return { onGuide: () => onOpenGuide(guide.id), onTheWay: false, error: null };
  const over = guide?.id ?? null;
  const onTheWay = askedOver === over || (guide ? pullThreadGuideAsked(thread, line.stack, over) : (line.link.ask === 'guide' || line.link.ask === 'custom') && !line.link.guide?.review);
  if (onTheWay) return { onGuide: null, onTheWay: true, error: null };
  const target = guideRequestTarget(thread);
  // The PR's link is this thread's (`reviewViewOf` gives no line otherwise); an archived thread, or a host that gets no
  // guided reviews, has no agent to ask.
  if (!target || line.link.thread_id !== thread.thread_id) return { onGuide: null, onTheWay: false, error };
  const ask = async () => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    const request = requests.get(thread.thread_id) ?? { key: newUuid(), sent: false };
    requests.set(thread.thread_id, request);
    try {
      if (!request.sent && !pullThreadGuideAsked(thread, line.stack, over)) {
        const words = pullThreadGuideWords(line.stack);
        const skills = await inboxSkillsBlock([words], INBOX_REPLY_SKILL_AUDIENCE);
        await inboxApi.reply(target.message.id, { idempotency_key: request.key, words: withSkillsBlock(words, skills), questions: [] });
        request.sent = true;
      }
    } catch (cause) {
      setError(`${PULL_GUIDE_NOT_SENT} ${cause instanceof Error && cause.message ? cause.message : 'Try again.'}`);
      busy.current = false;
      return;
    }
    try {
      await inboxApi.pullOwner(handoffKeys(line.stack), thread.thread_id, 'guide');
      requests.delete(thread.thread_id);
      setAskedOver(over);
      line.onAsked();
    } catch {
      setError(PULL_GUIDE_UNTOLD);
    } finally {
      busy.current = false;
    }
  };
  return { onGuide: () => void ask(), onTheWay: false, error };
}
