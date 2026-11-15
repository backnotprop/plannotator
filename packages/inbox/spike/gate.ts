/**
 * The free-layout spike (SPIKE, never merged): on only in a build run with INBOX_LAYOUT_SPIKE=1
 * (apps/inbox/vite.config.ts), and then only at `?layout-spike`. The define is a literal, so any other build folds
 * LAYOUT_SPIKE to false and drops the spike's lazy chunk and the vendored engine with it. (Not the Vite dev server:
 * the window reads its Inbox same-origin, so the spike runs from a sandboxed compiled binary.)
 */
declare const __INBOX_LAYOUT_SPIKE__: boolean;

export const LAYOUT_SPIKE: boolean = typeof __INBOX_LAYOUT_SPIKE__ !== 'undefined' && __INBOX_LAYOUT_SPIKE__;

export const layoutSpikeOn: boolean = LAYOUT_SPIKE && typeof location !== 'undefined' && new URLSearchParams(location.search).has('layout-spike');

/** A row's "Open in a pane" / "Open as a tab" (RowMenu) reaches the layout through this event. */
export const OPEN_IN_PANE_EVENT = 'ib-spike-open-in-pane';

export function openInPane(threadId: string, tab = false): void {
  window.dispatchEvent(new CustomEvent(OPEN_IN_PANE_EVENT, { detail: { threadId, tab } }));
}
