/**
 * The Sidebar tip (the owner, 2026-11-09: "the same thing we did for … launch new agents … you can customize the
 * sidebar … a little popover thing, arrow point into it"): a one-time card beside the sidebar that says it can be
 * customized. The Launch tip's sibling (launch-tip.ts), and pure the same way: the Inbox server
 * (packages/server/inbox.ts) builds the state from config.json, reports `due` to the page (`GET /api/inbox/settings`
 * `reveal.sidebar_tip`) and spends the claim (`POST /api/inbox/reveal` `id: "sidebar_tip"`).
 *
 * Who: the person's pages, on an Inbox whose sidebar was never customized (no layout was ever
 * saved: config.json `inboxSidebarRev` counts the saves, so a layout set back to the default still counts), a day or
 * more after the person's first use, until it was shown once. It stands outside the order of the line of one-time
 * dialogs (reveals.ts), but keeps its 40-minute gap both ways (the server: `tipFree`, `RevealState.tipShownAt`): it
 * never shows within the gap of a dialog, and no dialog follows it within the gap. The claim stamps only
 * config.json `inboxReveals.sidebar_tip`, when it shows (every way out is final), with the page's key so that page's
 * retry after a lost answer is shown it again and no other window is.
 */

/** A day after first use: never on a first-run day. */
export const SIDEBAR_TIP_TENURE_MS = 24 * 60 * 60 * 1000;

/** What config.json keeps: `inboxReveals.sidebar_tip`. */
export interface SidebarTipSaved {
  shownAt?: string;
  key?: string;
}

export interface SidebarTipState {
  /** A sidebar layout was saved at least once (config.json `inboxSidebarRev` above 0, or a saved `inboxSidebar`). */
  customized: boolean;
  /** The person's first use of the Inbox (an ISO time), or null while it is not known (nothing in the store yet). */
  firstUseAt: string | null;
  /** This Inbox keeps first use (a release build). A dev build keeps none, so it asks for no tenure. */
  tenure: boolean;
  saved: SidebarTipSaved | undefined;
}

function tenured(state: SidebarTipState, now: number): boolean {
  if (!state.tenure) return true;
  const first = state.firstUseAt ? Date.parse(state.firstUseAt) : NaN;
  return Number.isFinite(first) && now - first >= SIDEBAR_TIP_TENURE_MS;
}

/** The tip may show on this Inbox at `at`: what settings report as `reveal.sidebar_tip`. */
export function sidebarTipDue(state: SidebarTipState, at: string): boolean {
  return !state.customized && !state.saved?.shownAt && tenured(state, Date.parse(at));
}

/**
 * A page about to show the tip claims it at `at`. `show`: the page draws it. `save`: what to write to config.json
 * (`inboxReveals.sidebar_tip`), or null for nothing. The same page's key again (a retry after a lost answer) is shown
 * it again without a write, unless the sidebar was customized meanwhile; any other claim once it is stamped gets no.
 */
export function sidebarTipClaim(state: SidebarTipState, key: string | null, at: string): { show: boolean; save: SidebarTipSaved | null } {
  if (state.customized) return { show: false, save: null };
  if (key && state.saved?.shownAt && state.saved.key === key) return { show: true, save: null };
  if (!sidebarTipDue(state, at)) return { show: false, save: null };
  return { show: true, save: { ...state.saved, shownAt: at, ...(key ? { key } : {}) } };
}
