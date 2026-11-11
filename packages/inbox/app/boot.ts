/** Addresses settled before the window reads them: old links, a tour's ended entry, a stray `msg=`. */

import { tourStepOf } from '../tour/model';
import { withoutClickSignal } from '../history';
import { movedSettingsHash, parseSettingsHash, settingsHash } from '../settingsRoute';
import { reviewsAlias } from '../reviewsRoute';
import { readRoute, routeOf } from './route';
import { hashOf } from './writeRoute';

/** The history-entry mark an ended tour leaves on its own entry: the hash it went back to (approval "inbox-onboarding-tour"). */
export const TOUR_ENDED_STATE = 'ibTourEnded';

/**
 * A tour address, settled before the window reads it:
 * - an entry the tour ended from (Exit or Finish went back from it, leaving it
 *   ahead in history) is replaced by the screen the tour went back to, so the
 *   browser's Forward, or a reload of that entry, never reopens the tour;
 * - an odd step (`#tour=`, `0`, `abc`, `99`, `2.5`) is written as the step it reads as.
 */
export function settleTourEntry(): void {
  if (routeOf(window.location.hash).page !== 'tour') return;
  const state = window.history.state as Record<string, unknown> | null;
  if (state && typeof state[TOUR_ENDED_STATE] === 'string') {
    const { [TOUR_ENDED_STATE]: to, ...rest } = state;
    window.history.replaceState(rest, '', (to as string) || window.location.pathname + window.location.search);
    return;
  }
  const canonical = `#tour=${tourStepOf(new URLSearchParams(window.location.hash.replace(/^#/, '')).get('tour'))}`;
  if (window.location.hash !== canonical) window.history.replaceState(window.history.state, '', canonical);
}

/**
 * Set when a tour decision (finished, skipped) could not be saved on the server
 * (config.json unreadable, the server stopped): this browser remembers it, so
 * Two paths does not come back here. A cookie, so a port change keeps it.
 */
export const TOUR_DECIDED_COOKIE = 'plannotator-inbox-tour-decided';

/**
 * `#settings/experimental`, Experimental's own page before it moved into
 * Capabilities (the owner, 2026-10-27): the address becomes
 * `#settings/capabilities` in place (no new history entry). True when it
 * did, so the route keeps landing on the Experimental group.
 */
export function settleOldExperimental(): boolean {
  if (!parseSettingsHash(window.location.hash.replace(/^#/, ''))?.experimental) return false;
  window.history.replaceState(window.history.state, '', `#${settingsHash({ section: 'capabilities' })}`);
  return true;
}

/**
 * `#settings/decision-data`, Decision data's own page before it joined Activity (approval
 * "settings-storage-activity", 2026-11-08): the address becomes `#settings/activity` in place (no new history entry).
 */
export function settleMovedSettings(): void {
  const moved = movedSettingsHash(window.location.hash.replace(/^#/, ''));
  if (moved) window.history.replaceState(window.history.state, '', `#${moved}`);
}

/** A `msg=` with no thread to land in (a hand-edited or truncated link) leaves the address bar; the route already ignores it. */
export function stripStrayMsg(): void {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  if (!params.has('msg') || params.get('thread')) return;
  const hash = hashOf(readRoute());
  window.history.replaceState(window.history.state, '', hash || window.location.pathname + window.location.search);
}

/** A notification click's `click=` come back from the browser's own history (history.ts) leaves the address bar. */
export function stripClickSignal(): void {
  const clean = withoutClickSignal(window.location.hash);
  if (clean !== window.location.hash) window.history.replaceState(window.history.state, '', clean || window.location.pathname + window.location.search);
}

/** How long after the store changed Reviews' rows are read again (a burst of messages is one read). */
export const REVIEWS_AFTER_STORE_MS = 800;
export const REVIEWS_AFTER_STORE_MAX_MS = 4000;

/** `#pulls…` becomes `#reviews…` in place: the entry is kept, and every old link goes on working (reviewsRoute.ts). */
export function settleReviewsAlias(): void {
  const hash = reviewsAlias(window.location.hash);
  if (hash) window.history.replaceState(window.history.state, '', hash);
}
