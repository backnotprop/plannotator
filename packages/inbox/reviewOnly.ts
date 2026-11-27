/**
 * The Inbox for code review only, in the window (packages/server/inbox-review-only.ts; the owner's mocks, rounds 1-3,
 * 2026-11-23): one setting, `full_inbox` in the settings, off while the person uses the Inbox for code review only.
 * Then Reviews is home (a load on the Inbox, or on a page only the full Inbox has, goes to Reviews in place), the
 * sidebar loses what the full Inbox has (sidebarItems.ts; the Inbox row comes back while something there waits on the
 * person), the tour's entry screen and the agent note's dialog stay away, Settings → Capabilities has the Full Inbox
 * row (FullInboxRow.tsx) in place of Code review, Board, Checklist and Routines, and Settings → Agents has no Reminder
 * switch (no reminder is sent while code review only). The welcome `plannotator inbox --review` asks for is a dialog
 * of the line (`review_welcome`, `useReviewWelcome`).
 */
import { useEffect, useRef, useState } from 'react';
import type { Route } from './app/route';
import { writeRoute } from './app/writeRoute';
import { REVEAL_TIMES, useLineReveal, type RevealStage } from './reveal';
import type { CodeReviewOfferInput, CodeReviewOfferState } from './codeReviewOffer';

declare module './api' {
  // api.ts is at its size ceiling (tests/inbox-size-ceilings.json): the field is declared here.
  interface SettingsModel {
    /**
     * Full Inbox (config.json `inboxReviewOnly`): off while the person uses the Inbox for code review only. `chosen`:
     * they were in that mode at some point on this computer (Settings shows the row, so they can switch back). Absent
     * from an older Inbox: the full Inbox.
     */
    full_inbox?: { on: boolean; chosen?: true };
  }
}

export { ReviewWelcome } from './components/ReviewWelcome';

/** The window's one reading: code review only now, with Reviews made home when it starts (useReviewOnlyHome). */
export function useReviewOnly(settings: { full_inbox?: { on: boolean } } | null | undefined, route: Route): boolean {
  const reviewOnly = reviewOnlyOf(settings);
  useReviewOnlyHome(reviewOnly, route);
  return reviewOnly;
}

/** The person uses the Inbox for code review only (an older Inbox never says so). */
export function reviewOnlyOf(settings: { full_inbox?: { on: boolean } } | null | undefined): boolean {
  return settings?.full_inbox?.on === false;
}

/** The pages only the full Inbox has. The Inbox's list counts only without a thread open (a review's thread opens there). */
const FULL_INBOX_PAGES: ReadonlySet<Route['page']> = new Set(['board', 'artifacts', 'scheduled', 'plans', 'grid', 'tour']);

/** Where a load on `route` goes while code review only: Reviews, or null to stay. */
export function reviewOnlyHome(route: Route): Route | null {
  if (FULL_INBOX_PAGES.has(route.page) || (route.page === 'inbox' && !route.thread)) return { page: 'reviews', project: null, thread: null };
  return null;
}

/**
 * Reviews is home: when the settings first say code review only (a load, or the switch turned in another window), a
 * page only the full Inbox has goes to Reviews in place. Only then: the person may still open the Inbox row when it
 * shows, and it stays open.
 */
export function useReviewOnlyHome(reviewOnly: boolean, route: Route): void {
  const done = useRef(false);
  const latest = useRef(route);
  latest.current = route;
  useEffect(() => {
    if (!reviewOnly) {
      done.current = false;
      return;
    }
    if (done.current) return;
    done.current = true;
    const home = reviewOnlyHome(latest.current);
    if (home) writeRoute(home, { replace: true });
  }, [reviewOnly]);
}

/** Reviews with nothing over it (no search, no new message): where the welcome may open. */
export function reviewWelcomeClear(route: Pick<Route, 'page'>, over: { search: boolean; compose: boolean }): boolean {
  return route.page === 'reviews' && !over.search && !over.compose;
}

/**
 * The welcome to the code review Inbox as a dialog of the line (`review_welcome`, packages/shared/inbox/reveals.ts:
 * first in the queue, no tenure), the way Code review's offer goes (codeReviewOffer.ts): armed from `reveal.next`, at
 * once (`atOnce`) once Reviews is clear and settled, and it opens only after its claim (`POST /api/inbox/reveal`)
 * answers that this is the first showing ever, so two tabs never both show it; the claim keeps the line's gap after
 * it. `on`: still code review only (switched to the full Inbox meanwhile, it no longer opens). Closing it only closes
 * it: the welcome has no Not now. `launchMay`: the launch dialog may follow it on this load (`useLaunchAfterWelcome`).
 */
export function useReviewWelcome(input: CodeReviewOfferInput): CodeReviewOfferState & { launchMay: boolean } {
  const latest = useRef(input);
  latest.current = input;
  const reveal = useLineReveal({
    id: 'review_welcome',
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
    holds: () => latest.current.on,
    atOnce: true,
  });
  const settled = !input.due || input.blocked || !input.on || reveal.stage === 'shown';
  return { stage: reveal.stage, close: reveal.close, settled, launchMay: useLaunchAfterWelcome(reveal.stage) };
}

/**
 * The launch dialog may go on this load (App's `ready` for it): never while the welcome is claimed or open, and once
 * the welcome is done on this load (closed, or its claim answered no), after the line's usual gap
 * (`REVEAL_TIMES.otherDialogMs`), so a tab left open shows it then and the two never draw together. A load where the
 * welcome never came: at once.
 */
export function useLaunchAfterWelcome(stage: RevealStage): boolean {
  const [gapPassed, setGapPassed] = useState(false);
  useEffect(() => {
    if (stage !== 'shown') return;
    const timer = setTimeout(() => setGapPassed(true), REVEAL_TIMES.otherDialogMs);
    return () => clearTimeout(timer);
  }, [stage]);
  return stage === 'none' || (stage === 'shown' && gapPassed);
}
