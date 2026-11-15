/**
 * The Launch tip (approval "launch-tip", 2026-11-08, `.product/approved/launch-tip/`): a one-time card beside
 * compose's To that says agents can be started from there. Pure, so a test needs no Inbox; the Inbox server
 * (packages/server/inbox.ts) builds the state from config.json and the store, reports `due` to the page
 * (`GET /api/inbox/settings` `reveal.launch_tip`) and spends the claim (`POST /api/inbox/reveal` `id: "launch_tip"`).
 *
 * Who: the person's pages, on an Inbox where no agent was ever started (a launched thread root
 * in the store, or `launchedAt`, kept once one was seen, so deleting that thread never brings the tip back), until it
 * was shown once. Whether To can start an agent (Launch on here, or a linked machine's) is compose's own check
 * (`canStart`): it claims only when To offers a new session. It stands outside the order of the line of one-time dialogs
 * (packages/shared/inbox/reveals.ts), but keeps its 40-minute gap both ways since 2026-11-09, as the Sidebar tip does
 * (the server: `tipFree`, `RevealState.tipShownAt`): never within the gap of a dialog, and no dialog within the gap of it. The
 * claim stamps only config.json `inboxReveals.launch_tip`, when it shows (every way out is final), with the page's
 * key so that page's retry after a lost answer is shown it again and no other window or phone is.
 */

/** What config.json keeps: `inboxReveals.launch_tip`. */
export interface LaunchTipSaved {
  shownAt?: string;
  key?: string;
  /** An agent was started from this Inbox (first seen then): kept, so a deleted launched thread still counts. */
  launchedAt?: string;
}

export interface LaunchTipState {
  /** A launched thread root is in the store now (a deleted one is gone from it; `saved.launchedAt` remembers it). */
  launched: boolean;
  saved: LaunchTipSaved | undefined;
}

/** The tip may show on this Inbox: what settings report as `reveal.launch_tip`. */
export function launchTipDue(state: LaunchTipState): boolean {
  return !state.launched && !state.saved?.launchedAt && !state.saved?.shownAt;
}

/**
 * A page about to show the tip claims it at `at`. `show`: the page draws it. `save`: what to write to config.json
 * (`inboxReveals.launch_tip`), or null for nothing. The same page's key again (a retry after a lost answer) is shown it
 * again without a write; any other claim once it is stamped gets no.
 */
export function launchTipClaim(state: LaunchTipState, key: string | null, at: string): { show: boolean; save: LaunchTipSaved | null } {
  if (key && state.saved?.shownAt && state.saved.key === key) return { show: true, save: null };
  if (!launchTipDue(state)) return { show: false, save: null };
  return { show: true, save: { ...state.saved, shownAt: at, ...(key ? { key } : {}) } };
}

/**
 * The saved tip once an agent is seen started from this Inbox at `at` (a launched root appended, or found in the
 * store): `launchedAt` is kept from then on. Null when it is already kept (nothing to write).
 */
export function launchTipLaunched(saved: LaunchTipSaved | undefined, at: string): LaunchTipSaved | null {
  return saved?.launchedAt ? null : { ...saved, launchedAt: at };
}
