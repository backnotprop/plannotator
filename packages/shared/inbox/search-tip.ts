/**
 * The Search tip (the owner, 2026-11-26, after exact search with quotes: "a little helpful popover tip … for when users
 * use search the next time within the search box"): a one-time card at the search palette's box that says words in
 * quotes are an exact phrase. The Launch tip's sibling (launch-tip.ts), pure the same way: the Inbox server
 * (packages/server/inbox.ts) builds the state from config.json and the recent searches, reports `due` to the page
 * (`GET /api/inbox/settings` `reveal.search_tip`) and spends the claim (`POST /api/inbox/reveal` `id: "search_tip"`).
 *
 * Who: the person's pages, a day or more after the person's first use (the Sidebar tip's tenure: never on a first-run
 * day), until it was shown once. Not for someone who already searched with quotes: a recent search (the Inbox's
 * own list, kept when a result is opened) that holds a quote mark. It stands outside the order of the line of
 * one-time dialogs (reveals.ts), but keeps its 40-minute gap both ways, as the Sidebar and Launch tips do (the server:
 * `tipFree`, `RevealState.tipShownAt`). The claim stamps only config.json `inboxReveals.search_tip`, when it shows
 * (every way out is final), with the page's key so that page's retry after a lost answer is shown it again and no
 * other window is.
 */
import { SIDEBAR_TIP_TENURE_MS } from "./sidebar-tip";

/** What config.json keeps: `inboxReveals.search_tip`. */
export interface SearchTipSaved {
  shownAt?: string;
  key?: string;
}

export interface SearchTipState {
  /**
   * A recent search holds a quote mark: the person already searched for an exact phrase. Asked last, and only while
   * the tip could still be due (the server reads the recent searches from disk for it: never again once it was shown).
   */
  quoted: () => boolean;
  /** The person's first use of the Inbox (an ISO time), or null while it is not known (nothing in the store yet). */
  firstUseAt: string | null;
  /** This Inbox keeps first use (a release build). A dev build keeps none, so it asks for no tenure. */
  tenure: boolean;
  saved: SearchTipSaved | undefined;
}

function tenured(state: SearchTipState, now: number): boolean {
  if (!state.tenure) return true;
  const first = state.firstUseAt ? Date.parse(state.firstUseAt) : NaN;
  return Number.isFinite(first) && now - first >= SIDEBAR_TIP_TENURE_MS;
}

/** The tip may show on this Inbox at `at`: what settings report as `reveal.search_tip` (with the line's gap free). */
export function searchTipDue(state: SearchTipState, at: string): boolean {
  return !state.saved?.shownAt && tenured(state, Date.parse(at)) && !state.quoted();
}

/**
 * A page about to show the tip claims it at `at`. `show`: the page draws it. `save`: what to write to config.json
 * (`inboxReveals.search_tip`), or null for nothing. The same page's key again (a retry after a lost answer) is shown
 * it again without a write; any other claim once it is stamped gets no.
 */
export function searchTipClaim(state: SearchTipState, key: string | null, at: string): { show: boolean; save: SearchTipSaved | null } {
  if (key && state.saved?.shownAt && state.saved.key === key) return { show: true, save: null };
  if (!searchTipDue(state, at)) return { show: false, save: null };
  return { show: true, save: { ...state.saved, shownAt: at, ...(key ? { key } : {}) } };
}
