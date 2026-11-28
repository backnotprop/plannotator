/**
 * Where the Swarm first-time note stands on a computer (useSwarmTip.tsx; swarmBadge.css `.ib-sw-tip[data-side]`).
 *
 * New message's To row is the dialog's top row and the badge sits at its right end, so a note hung under the badge lay
 * over the message box and hid the ends of the person's own lines. It follows the Launch tip's rule for a card at To
 * (compose/launchTip.ts): beside, level with To, never over the message being written.
 *
 *  - `right`: right of the badge, its caret pointing left at it (the badge's right is the dialog's right edge, give or
 *    take the row's padding), when the window has the room there.
 *  - `above`: over the badge, caret pointing down, as on a phone, when there is no room beside but room above.
 *  - `below`: under it (the old place), only when neither fits.
 *
 * A phone always stands it above (its badge is in the foot's row); that is CSS alone (`[data-phone] .ib-sw-tip`).
 */
export type SwarmTipSide = 'right' | 'above' | 'below';

type Box = { left: number; right: number; top: number; bottom: number };

/** The gap between the badge and the note (the caret's room), and the least room kept from the window's edges. */
export const SWARM_TIP_GAP = 10;
const EDGE = 12;
/** Beside the badge: the caret's centre, from the note's top, stands level with the badge's centre. */
export const SWARM_TIP_CARET_Y = 24;

export function swarmTipSide(input: { badge: Box; note: { width: number; height: number }; window: { width: number; height: number } }): SwarmTipSide {
  const { badge, note, window: view } = input;
  const middle = (badge.top + badge.bottom) / 2;
  const besideTop = middle - SWARM_TIP_CARET_Y;
  if (badge.right + SWARM_TIP_GAP + note.width <= view.width - EDGE && besideTop >= EDGE && besideTop + note.height <= view.height - EDGE) return 'right';
  if (badge.top - SWARM_TIP_GAP - note.height >= EDGE) return 'above';
  return 'below';
}
