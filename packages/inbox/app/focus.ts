/** Closing a screen back to the one under it, and where focus goes when a screen opens. */

import type { ConnectContext } from '../harnesses';
import { modalOpen } from '../shortcuts/guards';
import { rowSwipeInHand } from '../rowSwipe';
import { replyBeingWritten, unsentReply } from '../unsent';
import { isPhone } from '../phone';
import { backTo, type HistoryLike } from '../history';
import { actedSince, inputMark } from '../lastInput';
import { focusLost } from '../backFocus';
import { focusFirst } from '../focusLanding';
import { readRoute, type Route } from './route';
import { hashOf, writeRoute } from './writeRoute';

/**
 * Leave the screen on top for the one under it (a thread for the list, a
 * file for its thread). On a phone that is the browser's Back when this
 * screen was opened from there (history.ts), so the swipe back and the Back
 * button agree. On a desktop, and for a screen reached any other way, it is
 * a new entry, so the browser's Back reopens what was just closed.
 */
export function closeTo(route: Route): void {
  if (!backOnClose(route, isPhone(), window.history)) writeRoute(route);
}

/**
 * The close as the browser's Back (returns true), or nothing and the caller writes a new entry (false). A layer's
 * diff opened from Reviews' list (a layer's row) goes back to that list, as a phone's swipe back does, and the list
 * it lands on shows that layer selected, its stack unfolded (`&back=`); opened from its stack's page, to that page.
 */
export function backOnClose(route: Route, phone: boolean, history: HistoryLike): boolean {
  const list = listUnder(route);
  if (list && (phone || covering.thread) && backTo(backHashOf(list), history, sameScreen, () => writeRoute(list, { replace: true }))) return true;
  return (phone || leavesCoveringPane(route)) && backTo(backHashOf(route), history, sameScreen);
}

/** The entry a close goes back to: the layer a diff closed from (`backLayer`) is only the list's selection, not a screen. */
export const backHashOf = (route: Route): string => hashOf({ ...route, backLayer: null });

/** An entry is the screen a close goes back to whatever layer its list showed selected (`&back=`, not a screen). */
const sameScreen = (from: string, hash: string): boolean => from === hash || (from.startsWith('#reviews') && from.replace(/&back=[^&]*/, '') === hash);

/** The Reviews list under a layer's closed diff (`layerClosed`), that layer its selection; null for any other close. */
export function listUnder(closed: Route): Route | null {
  return closed.page === 'reviews' && closed.stack && closed.backLayer ? { ...closed, stack: null, layer: null, scope: 'layer' } : null;
}

/**
 * Which panes cover their list now (a window too narrow for both, stack.ts),
 * kept in step by the window. Closing a covering thread back to the list is
 * then the browser's Back, as on a phone, so an iPad's swipe back and
 * `‹ Inbox` agree.
 * Every other close, and every close beside the list, stays a new entry, as on
 * a desktop.
 */
export const covering = { thread: false };

export function leavesCoveringPane(route: Route): boolean {
  if (!covering.thread) return false;
  const from = readRoute();
  if (route.page === 'inbox' && !route.thread) {
    return from.page === 'inbox' && !!from.thread && !from.file && !from.guide;
  }
  if (route.page === 'reviews' && !route.stack) {
    return from.page === 'reviews' && !!from.stack && !from.layer;
  }
  return false;
}

/** The thread covers the list (a phone, a stacked window): the list is out of sight while a thread is open. */
export function listCovered(): boolean {
  return isPhone() || covering.thread;
}

/** A row of the list on screen, by its thread (one element per row: the wide, three-line or phone row). */
export function rowElement(body: ParentNode, threadId: string): HTMLElement | null {
  // The one on screen: a list draws some rows twice (one hidden), and a row in folded Quiet is not drawn at all.
  return [...body.querySelectorAll<HTMLElement>(`[data-thread-id="${CSS.escape(threadId)}"]`)].find((el) => el.getClientRects().length > 0) ?? null;
}

/** The tab is visible and has focus: what the tour's replay needs to stand in for notifications with its chip. */
export function tourPageInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * A search result or a link just opened a screen: one with nothing to land on (a reply box already open with a
 * draft, no Reply to focus) leaves focus nowhere, so the thread's subject takes it, never the page. Not once the
 * person has acted since (a Send closing the box leaves focus nowhere for a moment too).
 */
export function focusAfterOpen(): void {
  const mark = inputMark();
  setTimeout(() => {
    if (!actedSince(mark) && focusLost(document.activeElement) && !modalOpen()) focusFirst(['section.ib-pane [data-reply-button]', 'section.ib-pane h2.ib-subject', '.ib-main h1']);
  }, 400);
}

/** How long the first-run screen waits for the settings before it draws without them. */
export const SETTINGS_LATE_MS = 1500;

/** How often the first-run screen reads the agents again while it shows, and the least gap between two reads (focus and the timer). */
export const FIRST_RUN_AGENTS_REFRESH_MS = 8_000;
export const FIRST_RUN_AGENTS_MIN_GAP_MS = 2_000;

export function platformOf(): ConnectContext['platform'] {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

/** A reply is being typed: the box holds unsent text, or a text field has focus. The sound dialog waits. */
export function replyInProgress(): boolean {
  if (unsentReply()) return true;
  const active = document.activeElement as HTMLElement | null;
  return !!active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
}

/**
 * The list options dialog waits (its claim unspent, or a claimed one unopened) while anything else is over the page or
 * a reply is under way: another dialog, a modal panel ui draws (`aria-modal`), an image opened full size, a pinned
 * reference card, a reply being typed, a reply box left open with words or files in it, wherever focus is, or a row
 * being swiped or resting open on its action (rowSwipe.ts `rowSwipeInHand`: never a dialog under a finger).
 */
export function listIntroHeldBack(): boolean {
  if (modalOpen() || replyInProgress() || replyBeingWritten() || rowSwipeInHand()) return true;
  return document.querySelector('[role="dialog"][aria-modal="true"], [data-image-lightbox], [data-ref-card-pinned]') !== null;
}
