/**
 * Code review's one-time offer, on the page (approval "code-review-offer-card", 2026-11-06; the owner: "this one needs
 * to show up like immediately"). Its slot is the line's (`CODE_REVIEW_OFFER`, packages/shared/inbox/reveals.ts: first
 * in the queue, no tenure, so it is `reveal.next` on day 0 while Code review was never decided). The page arms it from
 * `reveal.next`, and its moment needs no leave (`atOnce`): as soon as the tour's entry screen, its intro and the tour
 * itself are gone and the Inbox page is clear and settled, never over something typed or open, nor over a question
 * waiting in the open thread. The claim goes through the line (`useLineReveal`: `POST /api/inbox/reveal` `code_review`,
 * one stamp per Inbox, safe to repeat with the page's key). The agent note waits for it (`settled`), then keeps the
 * line's one-a-day rule.
 *
 * "Turn on code review" saves the switch as Settings → Capabilities does; "Not now", Escape and a click outside are the
 * line's Not now (`inboxApi.revealNotNow('code_review')`) and leave it off. Every way out is final.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import { useLineReveal, type RevealStage } from './reveal';

export interface CodeReviewOfferInput {
  /** The Inbox has it next for this page (settings `reveal.next === 'code_review'`), read once per load. */
  due: boolean;
  /** An update, the sound or another one-time dialog was on screen on this load. */
  blocked: boolean;
  /** The tour's entry screen, its intro or the tour itself is on screen: the offer never shows over them. */
  tourScreen: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it (listIntro.ts `listIntroPageClear`), no update dialog. */
  clear: boolean;
  place: string;
  /** Something typed or open over the page, or a question waiting in the open thread. */
  heldBack: () => boolean;
  toast: boolean;
  /** The settings say Code review is on (here, or another window or device): the offer no longer opens. */
  on: boolean;
}

export interface CodeReviewOfferState {
  stage: RevealStage;
  close: () => void;
  /** Nothing more to wait for on this load: not due, blocked, Code review on, or decided. The agent note waits for it. */
  settled: boolean;
}

export function useCodeReviewOffer(input: CodeReviewOfferInput): CodeReviewOfferState {
  const latest = useRef(input);
  latest.current = input;
  const reveal = useLineReveal({
    id: 'code_review',
    due: input.due,
    blocked: input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear && !input.tourScreen,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    // The moment is now (`atOnce`), never a leave.
    leaveCounts: () => false,
    mayClaim: () => !latest.current.tourScreen,
    holds: () => !latest.current.on,
    atOnce: true,
  });
  const settled = !input.due || input.blocked || input.on || reveal.stage === 'shown';
  return { stage: reveal.stage, close: reveal.close, settled };
}
