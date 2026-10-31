/** A box's viewport edges, as `getBoundingClientRect()` reports them. */
export interface BoxEdges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Space kept between the badge cluster and the action cluster. */
const ACTIONS_GAP = 8;

/**
 * The widest the legacy (absolutely positioned) badge cluster may grow before
 * it runs under the document's action cluster, so a long file name truncates
 * where the buttons start rather than at a fixed width.
 *
 * When no actions share the row (there are none, they have not been measured
 * yet, or the phone layout drops them below the badges), the cluster stops
 * inside the card instead, keeping the same inset on the right as on the left,
 * so the name truncates and the open-in button stays on screen. Null leaves
 * it unbounded while the card has no measured width (hidden, not laid out).
 */
export function legacyBadgesMaxWidth(badges: BoxEdges, actions: BoxEdges | null, card: BoxEdges): number | null {
  const inCard = card.right > card.left ? Math.max(0, card.right - badges.left - (badges.left - card.left)) : null;
  if (!actions || actions.right <= actions.left) return inCard;
  const sharesRow = actions.top < badges.bottom && actions.bottom > badges.top;
  if (!sharesRow) return inCard;
  return Math.max(0, actions.left - badges.left - ACTIONS_GAP);
}
