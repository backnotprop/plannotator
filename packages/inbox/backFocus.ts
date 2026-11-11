export interface BackFocusRoute {
  page: string;
  thread: string | null;
  file?: unknown;
}

const row = (thread: string) => `.ib-main .ib-lbody [data-thread-id="${CSS.escape(thread)}"]`;

export function backFocusTargets(to: BackFocusRoute, from: BackFocusRoute): string[] {
  if (to.page === 'board') return ['.ib-bpage h1'];
  if (to.page === 'settings') return ['.ib-spage h1'];
  if (to.page !== 'inbox') return ['.ib-main h1'];
  if (to.thread && to.file) return ['[data-attachment-pane]', row(to.thread), 'section.ib-pane h2.ib-subject'];
  if (to.thread) return [row(to.thread), 'section.ib-pane h2.ib-subject'];
  const left =
    from.page === 'inbox' && from.thread
      ? [row(from.thread), `.ib-main .ib-lbody [data-section-id]:has([data-thread-id="${CSS.escape(from.thread)}"]) button.ib-band`, '.ib-main .ib-lbody [data-section-id="quiet"] button.ib-band']
      : [];
  return [...left, '.ib-main .ib-lbody [data-thread-id]', '.ib-main .ib-lbody button.ib-band', '.ib-main .ib-empty h2', '.ib-main h1'];
}

export function focusKept(active: Element | null, to: BackFocusRoute, from: BackFocusRoute): boolean {
  if (!active || focusLost(active)) return false;
  if (active.closest('.ib-side')) return true;
  if (to.page !== 'inbox') return false;
  if (!to.thread) return !!active.closest('.ib-main .ib-lbody');
  if (from.page === 'inbox' && from.thread === to.thread && active.closest('section.ib-pane, [data-attachment-pane]')) return true;
  return active.matches(row(to.thread));
}

export function focusLost(active: Element | null): boolean {
  return !active || active === document.body || !active.isConnected || active.getClientRects().length === 0;
}
