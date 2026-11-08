/**
 * Shape's one-time offer, on the page (approval "shape-turn-on-dialog", 2026-11-08,
 * `.product/approved/shape-turn-on-dialog/`). Its slot is the line's (`SHAPE_OFFER`, packages/shared/inbox/reveals.ts:
 * between the Board and the Checklist, after 4 days and 5 threads, while Shape was never decided). The page arms it
 * from `reveal.next` and opens it at its moment (`shapeRevealLeaveCounts`, reveal.ts): back on the list from a thread
 * whose newest agent message is long, read 20 s or more, with the shared calm moment's rules (the page 60 s old, 5 rows,
 * nothing typed or open, no toast, settled). The claim goes through the line (`useLineReveal`: `POST /api/inbox/reveal`
 * `shape`, one stamp per Inbox, safe to repeat with the page's key) and turns nothing on.
 *
 * "Turn on Shape" saves the Shape switch as Settings → Capabilities does; "Not now", Escape and a click outside are the
 * line's Not now (`inboxApi.revealNotNow('shape')`) and leave it off. Every way out is final.
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useEffect, useRef } from 'react';
import { shapeRevealLeaveCounts, shapeRevealMayClaim, useLineReveal, type RevealStage } from './reveal';

export interface ShapeOfferInput {
  /** The Inbox has it next for this page (settings `reveal.next === 'shape'`), read once per load. */
  due: boolean;
  /** The tour, an update or another one-time dialog was on screen (or due) on this load (App's `revealBlocked`). */
  blocked: boolean;
  listLoaded: boolean;
  firstRun: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  /** The Inbox page with nothing over it (listIntro.ts `listIntroPageClear`). */
  clear: boolean;
  place: string;
  /** Something typed or open over the page, or a question waiting in the open thread. */
  heldBack: () => boolean;
  toast: boolean;
  /** The settings say Shape is on (here, or another window or device): the offer no longer opens. */
  on: boolean;
  /** Armed on this load (due, not blocked, Shape off): the dialog's picture starts loading (its chunk), so it is there when the dialog opens. */
  preload?: () => void;
}

export interface ShapeOfferState {
  stage: RevealStage;
  close: () => void;
}

export function useShapeOffer(input: ShapeOfferInput): ShapeOfferState {
  const latest = useRef(input);
  latest.current = input;
  const reveal = useLineReveal({
    id: 'shape',
    due: input.due,
    blocked: input.blocked,
    thread: input.thread,
    rows: input.rows,
    clear: input.clear,
    place: input.place,
    heldBack: input.heldBack,
    toast: input.toast,
    leaveCounts: (visit, now, _row, next) => shapeRevealLeaveCounts(visit, now, next),
    mayClaim: (pageAge) => shapeRevealMayClaim(latest.current, pageAge),
    // Turned on meanwhile (Settings here, or another window or device): nothing to offer.
    holds: () => !latest.current.on,
  });
  const armed = input.due && !input.blocked && !input.on;
  useEffect(() => {
    if (armed) latest.current.preload?.();
  }, [armed]);
  return { stage: reveal.stage, close: reveal.close };
}
