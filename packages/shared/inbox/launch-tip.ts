/**
 * The Launch tip (approval "launch-tip", 2026-11-08, `.product/approved/launch-tip/`): a one-time card beside
 * compose's To that says agents can be started from there. Pure, so a test needs no Inbox; the Inbox server
 * (packages/server/inbox.ts) builds the state from config.json and the store, reports `due` to the page
 * (`GET /api/inbox/settings` `reveal.launch_tip`) and spends the claim (`POST /api/inbox/reveal` `id: "launch_tip"`).
 *
 * Who: the owner's pages (never a tailnet guest's), while Launch is on, on an Inbox where no agent was ever started
 * (no launched thread root in the store), until it was shown once. It stands outside the line of one-time dialogs
 * (packages/shared/inbox/reveals.ts): it is not a dialog, so it neither waits for the line's day nor stamps it. The
 * claim stamps only config.json `inboxReveals.launch_tip`, when it shows (every way out is final), with the page's
 * key so that page's retry after a lost answer is shown it again and no other window or phone is.
 */

/** What config.json keeps: `inboxReveals.launch_tip`. */
export interface LaunchTipSaved {
  shownAt?: string;
  key?: string;
}

export interface LaunchTipState {
  /** The person at this computer or the owner over the tailnet: never a guest. */
  owner: boolean;
  /** Launch is on (`inboxLaunch.enabled`): To can offer a new session. */
  launchOn: boolean;
  /** An agent was already started from this Inbox (a launched thread root, deleted ones too). */
  launched: boolean;
  saved: LaunchTipSaved | undefined;
}

/** The tip may show on this Inbox: what settings report as `reveal.launch_tip`. */
export function launchTipDue(state: LaunchTipState): boolean {
  return state.owner && state.launchOn && !state.launched && !state.saved?.shownAt;
}

/**
 * A page about to show the tip claims it at `at`. `show`: the page draws it. `save`: what to write to config.json
 * (`inboxReveals.launch_tip`), or null for nothing. The same page's key again (a retry after a lost answer) is shown it
 * again without a write; any other claim once it is stamped gets no.
 */
export function launchTipClaim(state: LaunchTipState, key: string | null, at: string): { show: boolean; save: LaunchTipSaved | null } {
  if (!state.owner) return { show: false, save: null };
  if (key && state.saved?.shownAt && state.saved.key === key) return { show: true, save: null };
  if (!launchTipDue(state)) return { show: false, save: null };
  return { show: true, save: { shownAt: at, ...(key ? { key } : {}) } };
}
