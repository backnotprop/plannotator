/**
 * The Swarm tip (the owner, 2026-11-24: "the first time … hey, turn on swarm mode, and the agents will get extra
 * instructions…"): the first time the Swarm badge appears in New message, a small card at the badge says what turning
 * it on does. Once for the person, on any window or phone, then never. Pure, as the Group tip (band-tip.ts): the Inbox
 * server (packages/server/inbox.ts) spends the claim (`POST /api/inbox/reveal` `id: "swarm_tip"`) and stamps
 * config.json `inboxReveals.swarm_tip`, with the page's key so that page's retry after a lost answer is shown it again
 * and no other window is. No tenure and no gap: the person's own pick of a second agent calls it up.
 */

/** What config.json keeps: `inboxReveals.swarm_tip`. */
export interface SwarmTipSaved {
  shownAt?: string;
  key?: string;
}

/** A page whose badge just appeared claims the tip at `at`. `show`: the page draws it. `save`: what to write, or null. */
export function swarmTipClaim(saved: SwarmTipSaved | undefined, key: string | null, at: string): { show: boolean; save: SwarmTipSaved | null } {
  if (saved?.shownAt) return { show: !!key && saved.key === key, save: null };
  return { show: true, save: { shownAt: at, ...(key ? { key } : {}) } };
}
