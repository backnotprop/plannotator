export interface BoxEdges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

const ACTIONS_GAP = 8;

export function legacyBadgesMaxWidth(badges: BoxEdges, actions: BoxEdges | null, card: BoxEdges): number | null {
  const inCard = card.right > card.left ? Math.max(0, card.right - badges.left - (badges.left - card.left)) : null;
  if (!actions || actions.right <= actions.left) return inCard;
  const sharesRow = actions.top < badges.bottom && actions.bottom > badges.top;
  if (!sharesRow) return inCard;
  return Math.max(0, actions.left - badges.left - ACTIONS_GAP);
}
