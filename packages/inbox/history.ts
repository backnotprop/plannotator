export type HistoryLike = Pick<History, 'state' | 'pushState' | 'back'> & Partial<Pick<History, 'go' | 'length'>>;

export function pushScreen(hash: string, from: string, url: string, history: HistoryLike = window.history, extra?: Record<string, unknown>): void {
  if (hash !== from) history.pushState({ ...extra, ibFrom: from }, '', url);
}

/** A Back this window started and the browser has not landed yet: `history.state` changes only once it lands, so a second press (double click, two Escapes) would go back twice, out of the Inbox. */
let pending: ReturnType<typeof setTimeout> | null = null;

let landing: (() => void) | null = null;

let writing = 0;

function settle(): void {
  if (pending !== null) clearTimeout(pending);
  pending = null;
}

function start(then: (() => void) | undefined): void {
  landing = then ?? null;
  pending = setTimeout(() => {
    settle();
    landing = null;
  }, 1000);
}

/** Runs before the window reads the address, so an entry it rewrites is never drawn as it was. */
export function settleLanding(): void {
  if (writing > 0 || !landing) return;
  const then = landing;
  landing = null;
  then();
}

export function whileWritingRoute(write: () => void): void {
  writing += 1;
  try {
    write();
  } finally {
    writing -= 1;
  }
}

if (typeof window !== 'undefined') window.addEventListener('popstate', settle);

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

let clickSignals = 0;

/** Each step is a same-document navigation (no history entry, hashchange or popstate) so no route read sees it and the entry keeps its state. `location.replace` would fire both events and drop the state. Looks removable, and is not (see inbox-notifications-and-agents.md). */
export function signalNotificationClick(
  history: Pick<History, 'state' | 'replaceState'> = window.history,
  location: Pick<Location, 'href' | 'hash'> = window.location,
): void {
  const { href, hash } = location;
  const { state } = history;
  clickSignals += 1;
  history.replaceState(state, '', hash ? `${hash}&click=${clickSignals}` : `#click=${clickSignals}`);
  history.replaceState(state, '', href);
}

export function withoutClickSignal(hash: string): string {
  const rest = hash
    .replace(/^#/, '')
    .split('&')
    .filter((part) => !/^click=\d+$/.test(part))
    .join('&');
  return rest ? `#${rest}` : '';
}

export function backLanded(): void {
  settle();
}
