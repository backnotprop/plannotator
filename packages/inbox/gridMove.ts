/**
 * Where an arrow key goes between tiles laid out on screen (approval "inbox-keyboard-keys-2026-11-07", items 1 and
 * 6): the Artifacts grid and the Board's lanes. Pure: the boxes are the tiles' rectangles, in reading order.
 */

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const isGridKey = (key: string): key is GridKey => ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(key);

const centerX = (box: Box) => box.left + box.width / 2;
const centerY = (box: Box) => box.top + box.height / 2;

/**
 * A grid that wraps (the Artifacts tiles): ← → the tile before or after in reading order, ↑ ↓ the tile in the row
 * above or below nearest the current one's middle, Home End the first or last tile. Null: nowhere to go (an edge).
 */
export function gridStep(boxes: readonly Box[], from: number, key: GridKey): number | null {
  const last = boxes.length - 1;
  const here = boxes[from];
  if (!here || last < 0) return null;
  if (key === 'Home') return from === 0 ? null : 0;
  if (key === 'End') return from === last ? null : last;
  if (key === 'ArrowLeft') return from > 0 ? from - 1 : null;
  if (key === 'ArrowRight') return from < last ? from + 1 : null;
  const down = key === 'ArrowDown';
  const mid = centerY(here);
  // The rows past this one, in the key's direction: the nearest row is the one whose middle is closest.
  const ahead = boxes.map((box, index) => ({ box, index })).filter(({ box }) => (down ? centerY(box) > mid + here.height / 2 : centerY(box) < mid - here.height / 2));
  if (ahead.length === 0) return null;
  const rowY = ahead.reduce((best, { box }) => (Math.abs(centerY(box) - mid) < Math.abs(best - mid) ? centerY(box) : best), centerY(ahead[0]!.box));
  const row = ahead.filter(({ box }) => Math.abs(centerY(box) - rowY) < box.height / 2);
  const x = centerX(here);
  return row.reduce((best, item) => (Math.abs(centerX(item.box) - x) < Math.abs(centerX(best.box) - x) ? item : best)).index;
}

/**
 * Lanes of cards (the Board): ↑ ↓ within the lane, Home End its first or last card, ← → the card nearest this one's
 * height in the next lane that has cards. Null: nowhere to go.
 */
export function laneStep(lanes: readonly (readonly Box[])[], at: { lane: number; card: number }, key: GridKey): { lane: number; card: number } | null {
  const cards = lanes[at.lane];
  const here = cards?.[at.card];
  if (!cards || !here) return null;
  const last = cards.length - 1;
  if (key === 'ArrowUp') return at.card > 0 ? { lane: at.lane, card: at.card - 1 } : null;
  if (key === 'ArrowDown') return at.card < last ? { lane: at.lane, card: at.card + 1 } : null;
  if (key === 'Home') return at.card > 0 ? { lane: at.lane, card: 0 } : null;
  if (key === 'End') return at.card < last ? { lane: at.lane, card: last } : null;
  const step = key === 'ArrowRight' ? 1 : -1;
  for (let lane = at.lane + step; lane >= 0 && lane < lanes.length; lane += step) {
    const next = lanes[lane]!;
    if (next.length === 0) continue;
    const y = centerY(here);
    let best = 0;
    next.forEach((box, index) => {
      if (Math.abs(centerY(box) - y) < Math.abs(centerY(next[best]!) - y)) best = index;
    });
    return { lane, card: best };
  }
  return null;
}
