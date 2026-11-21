/**
 * Where focus lands after the browser's Back or Forward (approval
 * "inbox-keyboard-shortcuts", finding F1): where that page's own key puts it,
 * never on the page itself. The Board: its heading (G B). The list: the row
 * of the thread just left (or the Quiet band folding it), else the first row (G I). A thread: its row, else
 * its subject. A file: its pane. Settings: its heading (G S).
 *
 * Focus the traversal did not replace stays (focusKept).
 */
export interface BackFocusRoute {
  page: string;
  thread: string | null;
  file?: unknown;
}

const row = (thread: string) => `.ib-main .ib-lbody [data-thread-id="${CSS.escape(thread)}"]`;

/** The selectors to try, in order, after a traversal from `from` to `to`. */
export function backFocusTargets(to: BackFocusRoute, from: BackFocusRoute): string[] {
  if (to.page === 'board') return ['.ib-bpage h1'];
  if (to.page === 'settings') return ['.ib-spage h1'];
  if (to.page !== 'inbox') return ['.ib-main h1'];
  if (to.thread && to.file) return ['[data-attachment-pane]', row(to.thread), 'section.ib-pane h2.ib-subject'];
  if (to.thread) return [row(to.thread), 'section.ib-pane h2.ib-subject'];
  // The thread just left, else (folded away in Quiet, its row not drawn) the band that holds it, as closing it
  // by Escape does.
  const left =
    from.page === 'inbox' && from.thread
      ? [row(from.thread), `.ib-main .ib-lbody [data-section-id]:has([data-thread-id="${CSS.escape(from.thread)}"]) button.ib-band`, '.ib-main .ib-lbody [data-section-id="quiet"] button.ib-band']
      : [];
  return [...left, '.ib-main .ib-lbody [data-thread-id]', '.ib-main .ib-lbody button.ib-band', '.ib-main .ib-empty h2', '.ib-main h1'];
}

/**
 * Focus the traversal leaves where it is: in the sidebar; in the list when the list is where it went; on the row
 * of the thread it went to, or in that thread when it stayed open (a file closed or opened). Anything else (a row
 * of another thread, the thread before, a page) moves.
 */
export function focusKept(active: Element | null, to: BackFocusRoute, from: BackFocusRoute): boolean {
  if (!active || focusLost(active)) return false;
  if (active.closest('.ib-side')) return true;
  if (to.page !== 'inbox') return false;
  if (!to.thread) return !!active.closest('.ib-main .ib-lbody');
  // Within one thread (a file opened or closed), the thread puts focus back itself: where O was pressed.
  // So does a file's own Back (full screen back beside the thread puts focus on Side by side, fullScreenOrigin.ts).
  if (from.page === 'inbox' && from.thread === to.thread && active.closest('section.ib-pane, [data-attachment-pane]')) return true;
  return active.matches(row(to.thread));
}

/** Focus was taken by the traversal: nothing has it, or what has it left the page or is no longer drawn. */
export function focusLost(active: Element | null): boolean {
  return !active || active === document.body || !active.isConnected || active.getClientRects().length === 0;
}
