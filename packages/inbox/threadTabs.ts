/**
 * Thread tabs (Settings → Capabilities, config.json `inboxThreadTabs`; issue #4027): a tab at `#thread=<id>&alone`
 * shows that thread only. The tabs of one browser coordinate over the BroadcastChannel `plannotator-inbox-tabs`:
 *
 * - a thread tab announces `{ type: 'thread', tab, thread }` when it loads, on every ping and every heartbeat, and
 *   `{ type: 'gone', tab }` when it goes (pagehide). A main tab keeps the live set of those threads, the anchored
 *   threads, and drops a tab it has not heard from within `ANCHOR_TTL_MS` (a crashed tab says nothing).
 * - a main tab announces `{ type: 'main', tab, usedAt }` the same way, so the most recently used main tab is known
 *   to every main tab, and answers `{ type: 'open-in-main', id, route }` (a thread tab asking for a link to open)
 *   with `{ type: 'open-ack', id }` and opens it. No answer within `OPEN_ACK_MS`: the asker opens a new main tab.
 * - `{ type: 'ping' }` makes every tab announce (a tab that has just loaded).
 *
 * The logic is `createTabHub` over a `TabPort`, so it needs no browser; `browserTabPort` is the BroadcastChannel.
 */

export const TAB_CHANNEL = 'plannotator-inbox-tabs';
/** Every tab announces itself this often. */
export const HEARTBEAT_MS = 5_000;
/** A tab not heard from for three beats is not there any more. */
export const ANCHOR_TTL_MS = HEARTBEAT_MS * 3;
/** How long a thread tab waits for a main tab to say it will open a link. */
export const OPEN_ACK_MS = 800;

export type TabMessage =
  | { type: 'thread'; tab: string; thread: string }
  | { type: 'main'; tab: string; usedAt: number }
  | { type: 'gone'; tab: string }
  | { type: 'ping' }
  | { type: 'open-in-main'; id: string; route: string }
  | { type: 'open-ack'; id: string };

export type TabRole = { kind: 'thread'; thread: string } | { kind: 'main' };

export interface TabPort {
  post: (message: TabMessage) => void;
  listen: (handler: (message: TabMessage) => void) => () => void;
}

/** What `parseTabMessage` accepts off the wire (another page's data is never trusted). */
export function parseTabMessage(data: unknown): TabMessage | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 2000;
  switch (m.type) {
    case 'thread':
      return str(m.tab) && str(m.thread) ? { type: 'thread', tab: m.tab, thread: m.thread } : null;
    case 'main':
      return str(m.tab) && typeof m.usedAt === 'number' && Number.isFinite(m.usedAt) ? { type: 'main', tab: m.tab, usedAt: m.usedAt } : null;
    case 'gone':
      return str(m.tab) ? { type: 'gone', tab: m.tab } : null;
    case 'ping':
      return { type: 'ping' };
    case 'open-in-main':
      return str(m.id) && str(m.route) ? { type: 'open-in-main', id: m.id, route: m.route } : null;
    case 'open-ack':
      return str(m.id) ? { type: 'open-ack', id: m.id } : null;
    default:
      return null;
  }
}

/** The BroadcastChannel as a port; null where the browser has none (then every tab is simply a main tab). */
export function browserTabPort(): { port: TabPort; close: () => void } | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(TAB_CHANNEL);
  return {
    port: {
      post: (message) => channel.postMessage(message),
      listen: (handler) => {
        const on = (event: MessageEvent) => {
          const message = parseTabMessage(event.data);
          if (message) handler(message);
        };
        channel.addEventListener('message', on);
        return () => channel.removeEventListener('message', on);
      },
    },
    close: () => channel.close(),
  };
}

/** The tabs heard from, by tab id, each with when it was last heard. */
class Heard<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  constructor(private readonly ttl: number) {}
  hear(tab: string, value: T, at: number): void {
    this.entries.set(tab, { value, at });
  }
  forget(tab: string): void {
    this.entries.delete(tab);
  }
  /** The live entries; those not heard from within the ttl are dropped. */
  live(at: number): [string, T][] {
    for (const [tab, entry] of this.entries) if (at - entry.at >= this.ttl) this.entries.delete(tab);
    return [...this.entries].map(([tab, entry]) => [tab, entry.value]);
  }
}

export interface TabHub {
  /** The threads that have a live thread tab (a main tab's view; always empty in a thread tab). */
  anchored(): ReadonlySet<string>;
  /** This tab's role changed (a thread tab became main, or the reverse): it announces itself. */
  setRole(role: TabRole): void;
  /** This tab was used (focus): a main tab is then the one that opens links. */
  used(): void;
  /** Announce this tab and drop the tabs not heard from; every heartbeat. */
  beat(): void;
  /** Ask the most recently used main tab to open `route` (a hash); `unanswered` runs when none answers in time. */
  requestOpen(route: string, unanswered: () => void): void;
  /** Called when `anchored()` may have changed. */
  subscribe(listener: () => void): () => void;
  /** Say goodbye (pagehide) and stop listening. */
  close(): void;
}

export function createTabHub(options: {
  port: TabPort;
  /** This tab's id. */
  tab: string;
  role: TabRole;
  now?: () => number;
  /** A main tab was asked to open `route`, and it is the one to do it. */
  onOpen?: (route: string) => void;
  setTimer?: (run: () => void, ms: number) => () => void;
  newId?: () => string;
}): TabHub {
  const { port, tab } = options;
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((run, ms) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    });
  let sequence = 0;
  const newId = options.newId ?? (() => `${tab}:${++sequence}`);
  let role = options.role;
  let usedAt = now();
  const threads = new Heard<string>(ANCHOR_TTL_MS);
  const mains = new Heard<number>(ANCHOR_TTL_MS);
  const listeners = new Set<() => void>();
  const waiting = new Map<string, () => void>();
  let last = '';

  const anchoredNow = (): ReadonlySet<string> => (role.kind === 'main' ? new Set(threads.live(now()).map(([, thread]) => thread)) : new Set());
  const changed = () => {
    const key = [...anchoredNow()].sort().join('\n');
    if (key === last) return;
    last = key;
    for (const listener of listeners) listener();
  };
  const announce = () => {
    if (role.kind === 'thread') port.post({ type: 'thread', tab, thread: role.thread });
    else port.post({ type: 'main', tab, usedAt });
  };
  /** This main tab is the most recently used of the live ones (a tie goes to the greater tab id, so exactly one answers). */
  const mostRecent = (): boolean => {
    for (const [other, at] of mains.live(now())) if (other !== tab && (at > usedAt || (at === usedAt && other > tab))) return false;
    return true;
  };

  const stop = port.listen((message) => {
    switch (message.type) {
      case 'ping':
        announce();
        return;
      case 'thread':
        if (role.kind !== 'main') return;
        threads.hear(message.tab, message.thread, now());
        changed();
        return;
      case 'main':
        mains.hear(message.tab, message.usedAt, now());
        return;
      case 'gone':
        threads.forget(message.tab);
        mains.forget(message.tab);
        changed();
        return;
      case 'open-in-main':
        if (role.kind !== 'main' || !mostRecent()) return;
        port.post({ type: 'open-ack', id: message.id });
        options.onOpen?.(message.route);
        return;
      case 'open-ack': {
        const cancel = waiting.get(message.id);
        waiting.delete(message.id);
        cancel?.();
        return;
      }
    }
  });
  announce();
  port.post({ type: 'ping' });

  return {
    anchored: anchoredNow,
    setRole(next) {
      // The tab it was a moment ago is forgotten (a thread tab that became main is no longer anchored).
      if (role.kind === 'thread' && next.kind !== 'thread') port.post({ type: 'gone', tab });
      role = next;
      if (next.kind === 'main') usedAt = now();
      announce();
      port.post({ type: 'ping' });
      changed();
    },
    used() {
      usedAt = now();
      if (role.kind === 'main') announce();
    },
    beat() {
      announce();
      changed();
    },
    requestOpen(route, unanswered) {
      const id = newId();
      waiting.set(id, setTimer(() => {
        if (!waiting.delete(id)) return;
        unanswered();
      }, OPEN_ACK_MS));
      port.post({ type: 'open-in-main', id, route });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      port.post({ type: 'gone', tab });
      stop();
      listeners.clear();
    },
  };
}

/** Who raises OS notifications for which thread. */
export interface NotifyRole {
  /** The thread this tab shows alone (a thread tab), or null for a main tab. */
  alone: string | null;
  /** A main tab's anchored threads. */
  anchored: ReadonlySet<string>;
}

/** A thread tab notifies only for its own thread; a main tab skips the threads that have a thread tab. */
export function notifiesThread(role: NotifyRole, threadId: string): boolean {
  if (role.alone !== null) return role.alone === threadId;
  return !role.anchored.has(threadId);
}

/** The thread ids to leave out of a main tab's counts: the anchored ones, unless the sub-option puts them back. */
export function excludedFromCounts(anchored: ReadonlySet<string>, countAnchored: boolean): ReadonlySet<string> {
  return countAnchored ? new Set() : anchored;
}

export type ClickAction =
  /** Nothing special: the Inbox's own handling (and the browser's, for a modified click). */
  | 'default'
  /** ⌘/Ctrl-click: open the thread as a thread tab. */
  | 'open-alone'
  /** A plain click on an anchored thread: focus its tab, or say it is open elsewhere. */
  | 'focus-anchored'
  /** A plain click on another thread in a thread tab: the main tab opens it. */
  | 'ask-main';

/** ⌘ or Ctrl, alone, with the main button: the click that opens a thread tab. */
export function isThreadTabClick(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'button'>): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.button === 0;
}

/** What a click on a thread (a list row) or on a link to this Inbox (`thread` null: not to a thread) does. Off, nothing changes. */
export function routeClick(input: { enabled: boolean; role: TabRole; anchored: ReadonlySet<string>; thread: string | null; modified: boolean }): ClickAction {
  if (!input.enabled) return 'default';
  // A thread tab never navigates away from its thread: any other Inbox link goes to the main tab.
  if (input.role.kind === 'thread') return !input.modified && input.role.thread !== input.thread ? 'ask-main' : 'default';
  if (input.thread === null) return 'default';
  if (input.modified) return 'open-alone';
  return input.anchored.has(input.thread) ? 'focus-anchored' : 'default';
}

/** The thread tabs this tab opened (`window.open` keeps the WindowProxy, so it can focus them later). */
const kept = new Map<string, Window>();

/** `url` (the Inbox at `#thread=<id>&alone`) in a thread tab named for the thread: an open one is reused. */
export function openThreadTab(url: string, thread: string): void {
  const opened = window.open(url, `plannotator-thread-${thread}`);
  if (opened) kept.set(thread, opened);
}

/** Focus the thread tab this tab opened for `thread`, true when it is still open. */
export function focusThreadTab(thread: string): boolean {
  const tab = kept.get(thread);
  if (tab && !tab.closed) {
    tab.focus();
    return true;
  }
  kept.delete(thread);
  return false;
}

/** The tab that opened this one, when it is an Inbox tab of this origin (its `focus()` is then allowed). */
export function focusOpener(): void {
  try {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed && opener.location.origin === window.location.origin) opener.focus();
  } catch {
    // A cross-origin opener: nothing to focus.
  }
}
