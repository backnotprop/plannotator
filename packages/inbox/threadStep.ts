export type ThreadStep = { to: string } | { end: 'first' | 'last' } | null;

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

export function listOrder(body: ParentNode): string[] {
  const ids: string[] = [];
  for (const row of body.querySelectorAll<HTMLElement>('[data-thread-id]')) {
    const id = row.getAttribute('data-thread-id');
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

let arrival: string | null = null;

export function askArrivalFocus(threadId: string | null): void {
  arrival = threadId;
}

export function takeArrivalFocus(threadId: string): boolean {
  if (arrival !== threadId) return false;
  arrival = null;
  return true;
}
