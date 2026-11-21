/**
 * Next and previous thread (J / K; approval "inbox-keyboard-shortcuts", the
 * Shift+J/K addendum and the J/K swap addendum, 2026-10-27): the list's order as it shows, from the thread open
 * now. Folded Quiet is not drawn, so it is skipped; no wrap at the ends.
 */

export type ThreadStep = { to: string } | { end: 'first' | 'last' } | null;

/**
 * The thread `dir` away from `current` in `order` (ids top to bottom). When `current` left the rows on screen
 * while open (E moved it to folded Quiet, another tab archived it), it steps from the slot it had in `slot`, the
 * last order that drew it: the nearest row that way still on screen. Null when neither has it.
 */
export function threadStep(order: readonly string[], current: string, dir: 1 | -1, slot: readonly string[] = []): ThreadStep {
  const at = order.indexOf(current);
  if (at >= 0) {
    const to = order[at + dir];
    return to ? { to } : { end: dir > 0 ? 'last' : 'first' };
  }
  const was = slot.indexOf(current);
  if (was < 0) return null;
  const way = dir > 0 ? slot.slice(was + 1) : slot.slice(0, was).reverse();
  const to = way.find((id) => id !== current && order.includes(id));
  return to ? { to } : { end: dir > 0 ? 'last' : 'first' };
}

/** The ids of the rows the list draws, in order, once each (it draws some rows twice, one hidden). */
export function listOrder(body: ParentNode): string[] {
  const ids: string[] = [];
  for (const row of body.querySelectorAll<HTMLElement>('[data-thread-id]')) {
    const id = row.getAttribute('data-thread-id');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * From inside a thread, the thread the key opened puts focus where N would, once it has drawn: asked for here,
 * taken once by that thread (Thread.tsx).
 */
let arrival: string | null = null;

export function askArrivalFocus(threadId: string | null): void {
  arrival = threadId;
}

export function takeArrivalFocus(threadId: string): boolean {
  if (arrival !== threadId) return false;
  arrival = null;
  return true;
}
