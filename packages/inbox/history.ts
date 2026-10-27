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
export type HistoryLike = Pick<History, 'state' | 'pushState' | 'back'> & Partial<Pick<History, 'go' | 'length'>>;

/** Open `hash` as a new entry that remembers `from` (and any `extra` marks), unless it is the hash on screen. */
export function pushScreen(hash: string, from: string, url: string, history: HistoryLike = window.history, extra?: Record<string, unknown>): void {
  if (hash !== from) history.pushState({ ...extra, ibFrom: from }, '', url);
}

/**
 * A Back this window started and the browser has not landed yet. `history.state`
 * changes only once the traversal lands, so a second press in the meantime (a
 * double click on Back, two Escapes) would read the old entry and go back
 * twice, out of the Inbox. Until the next popstate (or a second, if none
 * comes) another backTo is taken as already done.
 */
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * What to do once the Back on its way lands (`then` of backTo and backBy),
 * held with the Back that set it: a second press while one is on its way
 * starts no Back and sets nothing, so it never takes the first one's place.
 */
let landing: (() => void) | null = null;

/** Route writes running now (App.tsx's writeRoute): their own hashchange is not a Back landing. */
let writing = 0;

function settle(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
}

/** Start a Back: the guard against a second press, and what to do once it lands. */
function start(then: (() => void) | undefined): void {
  landing = then ?? null;
  pending = setTimeout(() => {
    // It never landed (nothing to go back to): drop what was waiting for it.
    settle();
    landing = null;
  }, 1000);
}

/**
 * The traversal landed (the window's route listener, on popstate or, in some
 * engines, only hashchange): run what the Back that started it asked for,
 * before the window reads the address, so an entry it rewrites is never drawn
 * as it was (no flash of another file, no page frame reloaded). Nothing runs
 * for the window's own route writes (`whileWritingRoute`), which fire a
 * hashchange before the Back lands.
 */
export function settleLanding(): void {
  if (writing > 0 || !landing) return;
  const then = landing;
  landing = null;
  then();
}

/** Run a route write (and its own hashchange): a Back still on its way does not land in it. */
export function whileWritingRoute(write: () => void): void {
  writing += 1;
  try {
    write();
  } finally {
    writing -= 1;
  }
}

if (typeof window !== 'undefined') window.addEventListener('popstate', settle);

/**
 * Leave for `hash`: the browser's Back when this entry was opened from
 * exactly there (returns true), otherwise nothing, and the caller opens it
 * as a new entry (returns false). While a Back is on its way, returns true
 * and does nothing. `same` decides what "exactly there" means (default: the
 * same hash; a linked page's Back ignores the file's view, fileView.ts).
 */
export function backTo(
  hash: string,
  history: HistoryLike = window.history,
  same: (from: string, hash: string) => boolean = (a, b) => a === b,
  then?: () => void,
): boolean {
  if (pending !== null) return true;
  const state = history.state as { ibFrom?: unknown } | null;
  if (!state || typeof state.ibFrom !== 'string' || !same(state.ibFrom, hash)) return false;
  start(then);
  history.back();
  return true;
}

/**
 * Back by `steps` entries (full screen back onto the entry beside the thread
 * it was entered from, fullScreenOrigin.ts), with the same guard against a
 * second press while one is on its way; `then` runs once it lands
 * (settleLanding). The entries under it are this window's own: only its own
 * pushes mark an entry with a depth, one entry per step. Returns false
 * (nothing done, the caller writes the route instead) when `steps` is not a
 * positive count, would go back past the history's first entry, or needs a
 * `go` the history lacks: it never leaves the Inbox.
 */
export function backBy(steps: number, history: HistoryLike = window.history, then?: () => void): boolean {
  if (pending !== null) return true;
  if (!Number.isInteger(steps) || steps < 1) return false;
  if (typeof history.length === 'number' && steps >= history.length) return false;
  if (steps > 1 && !history.go) return false;
  start(then);
  if (steps === 1) history.back();
  else history.go!(-steps);
  return true;
}

/** For tests: the traversal landed (what the popstate listener does). */
export function backLanded(): void {
  settle();
}
