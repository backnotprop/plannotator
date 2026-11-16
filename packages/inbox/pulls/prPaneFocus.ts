/**
 * Focus for a PR's pane on the Reviews page (its launchpad, or a stack's page) where it covers the list: a window too
 * narrow for both side by side (stack.ts). The rules a covering thread follows (App.tsx, its `‹ Inbox`):
 *  - opened over the list, focus goes to the pane's `‹ Reviews` (`PullPaneBack`); closed back to it, to the PR's row;
 *  - the window shrinking into covering with focus on the list (now hidden under the pane), or lost (the pane's Close
 *    gone), puts it on `‹ Reviews`; growing back out with focus lost (that way back gone), on the PR's row.
 * Not on a phone, which shows one screen at a time and focuses the pane's title itself.
 */
import { useEffect, useRef } from 'react';

/** The covering pane's way back, else its title. */
export const PR_PANE_BACK: readonly string[] = ['section.ib-prpane [data-stack-back]', 'section.ib-prpane h2.ib-pr-h'];

/** The Reviews list's row for an open PR (`stack`: its stack's id, or one of its layers' keys): that row, else the selected one. */
export function prRowSelectors(stack: string): string[] {
  return [`.ib-prlist [data-pulls-row="${CSS.escape(stack)}"]`, '.ib-prlist [aria-current="true"]'];
}

/**
 * `prPane`: the open PR (the route's `stack`) while its pane shows on the Reviews page, else null. `covering`: the
 * window stacks (`useStack(...).thread`). `focus`: focus the first shown match (App.tsx `focusFirst`).
 */
export function usePrPaneFocus(prPane: string | null, covering: boolean, phone: boolean, focus: (selectors: readonly string[]) => boolean): void {
  const before = useRef({ pane: prPane, covering });
  useEffect(() => {
    const was = before.current;
    before.current = { pane: prPane, covering };
    if (phone) return;
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || active.getClientRects().length === 0 || getComputedStyle(active).visibility === 'hidden';
    if (was.pane !== prPane) {
      if (!covering) return;
      if (prPane && !was.pane) focus(PR_PANE_BACK);
      else if (!prPane && was.pane) focus(prRowSelectors(was.pane));
      return;
    }
    if (!prPane || was.covering === covering) return;
    if (covering) {
      if (lost || active?.closest('.ib-listcol')) focus(PR_PANE_BACK);
    } else if (lost) {
      focus(prRowSelectors(prPane));
    }
  }, [prPane, covering, phone, focus]);
}
