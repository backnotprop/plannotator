/**
 * ↑ ↓ Home End in the list (approval "inbox-keyboard-shortcuts"): focus moves
 * between the list's stops (each row, and each group's header) and never
 * opens a thread; Enter does. Tab order is unchanged (no roving tabindex: the
 * rows keep their own actions, design "Tab stays").
 */
export type ListMove = 'next' | 'previous' | 'first' | 'last';

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

export const LIST_STOPS = '[data-thread-id], button.ib-band';
export const LIST_ROWS = '[data-thread-id]';

export function listStops(body: ParentNode): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(LIST_STOPS)].filter((el) => el.getClientRects().length > 0);
}

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
  const ahead = after ? all.slice(here + 1) : all.slice(0, here).reverse();
  const next = ahead.find((el) => el.matches(LIST_ROWS));
  return next ?? null;
}
