/**
 * The Group tip (the owner, 2026-11-20: "We would need to inform the users they can do that though... Like a one-time
 * kind of like hover thing"): the first time the person points at a group band that has a menu (Mark all as read,
 * Archive all), the band's own tooltip says once that a right-click opens it ("Hold a group for actions" on a phone).
 * Pure, as the Sidebar tip (sidebar-tip.ts): the Inbox server (packages/server/inbox.ts) builds the state from
 * config.json, reports `due` to the page (`GET /api/inbox/settings` `reveal.band_tip`) and spends the claim
 * (`POST /api/inbox/reveal` `id: "band_tip"`).
 *
 * Who: the person's pages, a day or more after the person's first use (the Sidebar tip's tenure: never on a first-run
 * day), until it was shown once, or until the person opened a band's menu by themselves (the page claims it then too,
 * so it never shows). It is a tooltip the person's own pointer calls up, not a dialog: it is reported due only outside
 * the gap of a dialog, but it starts no gap and keeps none for its claim. The claim stamps only config.json
 * `inboxReveals.band_tip`, with the page's key so that page's retry after a lost answer is shown it again and no other
 * window is.
 */
import { SIDEBAR_TIP_TENURE_MS } from "./sidebar-tip";

/** What config.json keeps: `inboxReveals.band_tip`. */
export interface BandTipSaved {
  shownAt?: string;
  key?: string;
  /** The person opened a band's menu before the tip ever showed: it never will (`bandTipUsed`). */
  usedAt?: string;
}

export interface BandTipState {
  /** The person's first use of the Inbox (an ISO time), or null while it is not known (nothing in the store yet). */
  firstUseAt: string | null;
  /** This Inbox keeps first use (a release build). A dev build keeps none, so it asks for no tenure. */
  tenure: boolean;
  saved: BandTipSaved | undefined;
}

function tenured(state: BandTipState, now: number): boolean {
  if (!state.tenure) return true;
  const first = state.firstUseAt ? Date.parse(state.firstUseAt) : NaN;
  return Number.isFinite(first) && now - first >= SIDEBAR_TIP_TENURE_MS;
}

/** The tip may show on this Inbox at `at`: what settings report as `reveal.band_tip` (with the line's gap free). */
export function bandTipDue(state: BandTipState, at: string): boolean {
  return !state.saved?.shownAt && tenured(state, Date.parse(at));
}

/**
 * A page about to show the tip (or retiring it: the person opened a band's menu) claims it at `at`. `show`: the page
 * draws it. `save`: what to write to config.json (`inboxReveals.band_tip`), or null for nothing. The same page's key
 * again (a retry after a lost answer) is shown it again without a write; any other claim once it is stamped gets no.
 */
export function bandTipClaim(state: BandTipState, key: string | null, at: string): { show: boolean; save: BandTipSaved | null } {
  if (key && state.saved?.shownAt && state.saved.key === key) return { show: true, save: null };
  if (!bandTipDue(state, at)) return { show: false, save: null };
  return { show: true, save: { ...state.saved, shownAt: at, ...(key ? { key } : {}) } };
}

/**
 * The person opened a band's menu: they found it, so the tip is never shown. Stamped whatever the tenure or a dialog's
 * gap (someone who finds the menu on their first day is not told about it on the second). `save`: what to write to
 * config.json, or null when it is stamped already.
 */
export function bandTipUsed(state: BandTipState, at: string): BandTipSaved | null {
  if (state.saved?.shownAt) return null;
  return { ...state.saved, shownAt: at, usedAt: at };
}
