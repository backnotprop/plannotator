/**
 * ↑ ↓ Home End in the list (approval "inbox-keyboard-shortcuts"): focus moves
 * between the list's stops (each row, and each group's header) and never
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

/** The list's stops on screen, in order: rows (one element per row) and the groups' headers. */
export const LIST_STOPS = '[data-thread-id], button.ib-band';
/** A row of the list (one element per row), without the groups' headers. */
export const LIST_ROWS = '[data-thread-id]';

export function listStops(body: ParentNode): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(LIST_STOPS)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Where a list key moves focus from `from` (a row or a group's header), or null: nowhere to go.
 * ↓ ↑ (`down`, `up`) stop on the rows and on every group's header, so a closed group can be reached and opened.
 * Home End (`first`, `last`) and J K with no thread open (`j`, `k`) go to threads only: the first or last row, the
 * next or previous row, from a header the row after or before it. With no row on screen (every group closed) Home
 * and End fall back to the headers.
 */
export function listKeyTarget(body: ParentNode, from: Element | null, key: 'down' | 'up' | 'first' | 'last' | 'j' | 'k'): HTMLElement | null {
  const all = listStops(body);
  const rows = all.filter((el) => el.matches(LIST_ROWS));
  if (key === 'down' || key === 'up') {
    const at = listMoveIndex(all.length, from ? all.indexOf(from as HTMLElement) : -1, key === 'down' ? 'next' : 'previous');
    return at === null ? null : (all[at] ?? null);
  }
  if (key === 'first' || key === 'last') {
    const pool = rows.length > 0 ? rows : all;
    return (key === 'first' ? pool[0] : pool[pool.length - 1]) ?? null;
  }
  const here = from ? all.indexOf(from as HTMLElement) : -1;
  if (here < 0) return rows[0] ?? null;
  const after = key === 'j';
  // The nearest row past `from` in the list's order (a row's own neighbour, or the first row under a header).
  const ahead = after ? all.slice(here + 1) : all.slice(0, here).reverse();
  const next = ahead.find((el) => el.matches(LIST_ROWS));
  return next ?? null;
}
