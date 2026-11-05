/**
 * The Reviews page's address (approval "inbox-reviews-page"): `#reviews`, and `#pulls` as its permanent alias. Links to
 * `#pulls` live outside this repository (Workspaces, people's notes), so the old address keeps working for good: its
 * parameters are kept and the entry is rewritten in place.
 */
export function reviewsAlias(hash: string): string | null {
  const match = /^#pulls(?=&|$)/.exec(hash);
  return match ? `#reviews${hash.slice(match[0].length)}` : null;
}
