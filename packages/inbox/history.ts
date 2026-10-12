/**
 * The window's history on a phone, as the stack it looks like. Each screen
 * the window opens is a new history entry that remembers the hash it was
 * opened from (`ibFrom`). On a phone, leaving a screen for the one it was
 * opened from is then the browser's Back, so the swipe back on iOS, Android's
 * back button and the window's own Back button agree, and none of them
 * reopens what was just left. A screen reached any other way (a
 * notification, a link, a reload) goes to the screen under it as a new
 * entry, as every close does on a desktop.
 */

/** The parts of `window.history` these use (a test hands in its own). */
export type HistoryLike = Pick<History, 'state' | 'pushState' | 'back'>;

/** Open `hash` as a new entry that remembers `from`, unless it is the hash on screen. */
export function pushScreen(hash: string, from: string, url: string, history: HistoryLike = window.history): void {
  if (hash !== from) history.pushState({ ibFrom: from }, '', url);
}

/**
 * A Back this window started and the browser has not landed yet. `history.state`
 * changes only once the traversal lands, so a second press in the meantime (a
 * double click on Back, two Escapes) would read the old entry and go back
 * twice, out of the Inbox. Until the next popstate (or a second, if none
 * comes) another backTo is taken as already done.
 */
let pending: ReturnType<typeof setTimeout> | null = null;

function settle(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
}

if (typeof window !== 'undefined') window.addEventListener('popstate', settle);

/**
 * Leave for `hash`: the browser's Back when this entry was opened from
 * exactly there (returns true), otherwise nothing, and the caller opens it
 * as a new entry (returns false). While a Back is on its way, returns true
 * and does nothing.
 */
export function backTo(hash: string, history: HistoryLike = window.history): boolean {
  if (pending !== null) return true;
  const state = history.state as { ibFrom?: unknown } | null;
  if (!state || state.ibFrom !== hash) return false;
  pending = setTimeout(settle, 1000);
  history.back();
  return true;
}

/** For tests: the traversal landed (what the popstate listener does). */
export function backLanded(): void {
  settle();
}
