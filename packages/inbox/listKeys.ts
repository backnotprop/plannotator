/**
 * ↑ ↓ Home End in the list (approval "inbox-keyboard-shortcuts"): focus moves
 * between the list's stops (each row, and the Quiet band's toggle) and never
 * opens a thread; Enter does. Tab order is unchanged (no roving tabindex: the
 * rows keep their own actions, design "Tab stays").
 */
export type ListMove = 'next' | 'previous' | 'first' | 'last';

/** The stop a move lands on, from `index` among `count` stops (-1: none focused). Null: nowhere to go. */
export function listMoveIndex(count: number, index: number, move: ListMove): number | null {
  if (count === 0) return null;
  switch (move) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return index < 0 ? 0 : Math.min(count - 1, index + 1);
    case 'previous':
      return index < 0 ? 0 : Math.max(0, index - 1);
  }
}

/** The list's stops on screen, in order: rows (one element per row) and the Quiet band's toggle. */
export const LIST_STOPS = '[data-thread-id], button.ib-band';

export function listStops(body: ParentNode): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(LIST_STOPS)].filter((el) => el.getClientRects().length > 0);
}
