import type { InboxListRow } from '@plannotator/core/inbox-types';
import { useRef } from 'react';
import { useLineReveal, type RevealStage } from './reveal';

export interface CodeReviewOfferInput {
  due: boolean;
  blocked: boolean;
  tourScreen: boolean;
  thread: string | null;
  rows: readonly InboxListRow[];
  clear: boolean;
  place: string;
  heldBack: () => boolean;
  toast: boolean;
  on: boolean;
}

export interface CodeReviewOfferState {
  stage: RevealStage;
  close: () => void;
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
    leaveCounts: () => false,
    mayClaim: () => !latest.current.tourScreen,
    holds: () => !latest.current.on,
    atOnce: true,
  });
  const settled = !input.due || input.blocked || input.on || reveal.stage === 'shown';
  return { stage: reveal.stage, close: reveal.close, settled };
}
