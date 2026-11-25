/**
 * The Inbox for code review only, in the window (packages/server/inbox-review-only.ts; the owner's mocks, rounds 1-3,
 * 2026-11-23): one setting, `full_inbox` in the settings, off while the person uses the Inbox for code review only.
 * Then Reviews is home (a load on the Inbox, or on a page only the full Inbox has, goes to Reviews in place), the
 * sidebar keeps Search, Reviews, Drafts while there are some, Usage, Feedback and Settings (sidebarItems.ts; the Inbox
 * row comes back while something there waits on the person), the tour's entry screen and the agent note's dialog stay
 * away, and Settings → Capabilities has the Full Inbox row (FullInboxRow.tsx) without Board, Checklist and Routines.
 */
import { useEffect, useRef } from 'react';
import type { Route } from './app/route';
import { writeRoute } from './app/writeRoute';

declare module './api' {
  // api.ts is at its size ceiling (tests/inbox-size-ceilings.json): the two fields are declared here.
  interface SettingsModel {
    /** Full Inbox (config.json `inboxReviewOnly`): off while the person uses the Inbox for code review only. `chosen`: they chose either way once (the Settings row shows). Absent from an older Inbox: the full Inbox. */
    full_inbox?: { on: boolean; chosen?: true };
    /** The welcome dialog `plannotator inbox --review` asked for is due on this load. */
    review_welcome?: true;
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
