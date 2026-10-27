/**
 * One event stream for every Inbox tab of an origin.
 *
 * Each Inbox tab used to open its own EventSource, which holds one HTTP/1.1
 * connection for the tab's life. Chrome allows six connections per host, so
 * a seventh Inbox tab (and anything else on that origin) stalled. Now the
 * tabs of one origin elect a leader with a Web Lock (`EVENTS_LOCK`, held for
 * as long as the tab leads): the leader opens the stream and passes every
 * frame on over `BroadcastChannel(EVENTS_CHANNEL)`; the others, followers,
 * only listen. Every tab still gets every frame and runs its own handlers
 * (list reads, notifications with their claims, the sound with its lock), so
 * nothing above this module changes.
 *
 * Handover. When the leader closes, crashes or navigates, the browser frees
 * its lock and the next tab in the lock's queue becomes leader. It opens the
 * stream at the highest seq it has seen (the server replays every line after
 * it), so no record is missed; each tab drops a record whose seq it already
 * passed, so none is handled twice. A tab the browser freezes (`freeze`, or a
 * page entering the back/forward cache) steps down first and queues again as
 * it resumes, so a frozen tab never holds the stream for the others.
 *
 * Presence. The server counts a window for `notify_reach` while it holds a
 * stream; a follower holds none, so it reports `served_by` (the leader's
 * window id, `inboxEventsServedBy`) on every report, and the server counts it
 * while that leader is known (packages/server/inbox-windows.ts). Each tab
 * holds a lock of its own (`WINDOW_LOCK_PREFIX` + its id) for its life; the
 * leader queues for each follower's lock, which the browser grants when that
 * tab is gone (closed or crashed), and tells the server (`gone`). A tab also
 * says so itself at pagehide (a beacon).
 *
 * Where Web Locks or BroadcastChannel is missing (an older browser, an
 * insecure context) `subscribeInboxEvents` opens this tab's own stream, as
 * before. Locks and channels are per origin, so `localhost:<port>` and the
 * tailnet address never share (and a tab left on an old port has its own).
 */

import type { InboxEventFrame, InboxEventHandlers, InboxEventWindow } from './api';

/** The Web Lock the leader holds while it holds the stream. */
export const EVENTS_LOCK = 'plannotator-inbox-events';
/** The channel the leader passes frames on. */
export const EVENTS_CHANNEL = 'plannotator-inbox-events';
/** Each tab's own lock, held for its life; its release tells the leader the tab is gone. */
export const WINDOW_LOCK_PREFIX = 'plannotator-inbox-window:';
/** Frames a tab keeps from the channel before it subscribes (its first list read): beyond this it reads the list again anyway. */
export const EARLY_FRAMES_MAX = 5000;

/** What travels on the channel. `v` lets a later shape be ignored by an older tab. */
export type SharedEventsMessage =
  | { v: 1; type: 'frame'; leader: string; frame: InboxEventFrame }
  /**
   * A tab became leader (`to` absent), or answers one tab's join (`to` its id).
   * `from`: the seq its stream started after; a tab that has seen less fetches the lines between.
   */
  | { v: 1; type: 'leader'; window: string; from: number; to?: string }
  /** A follower is here (or wants to know the leader): the leader watches its lock and answers. */
  | { v: 1; type: 'join'; window: string }
  /** A visible follower asks whether a leader is alive (its main thread runs); the leader answers at once. */
  | { v: 1; type: 'ping'; window: string; nonce: string }
  | { v: 1; type: 'pong'; leader: string; to: string; nonce: string };

/**
 * How often a follower checks that the leader answers: a visible one every
 * few seconds (and when it becomes visible or gets focus), a hidden one less
 * often (the person is away, but a notification is still owed); and how long
 * it waits for the answer.
 */
export const LEADER_PING_EVERY_MS = 3000;
export const LEADER_HIDDEN_PING_EVERY_MS = 15_000;
export const LEADER_PONG_TIMEOUT_MS = 2000;
/** A failed catch-up is tried again after this, doubling up to `CATCH_UP_RETRY_MAX_MS`. */
export const CATCH_UP_RETRY_MS = 1000;
export const CATCH_UP_RETRY_MAX_MS = 30_000;

interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal; steal?: boolean }, callback: () => Promise<unknown> | unknown): Promise<unknown>;
}

interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

/** What the module needs from the page; tests pass fakes. */
export interface SharedEventsEnv {
  locks: LockManagerLike;
  channel: (name: string) => ChannelLike;
  /** Open this tab's own stream (api.ts `openInboxEventFrames`). */
  open: (cursor: number, onFrame: (frame: InboxEventFrame) => void, win: InboxEventWindow) => () => void;
  /** One frame to the handlers (api.ts `dispatchInboxFrame`). */
  dispatch: (frame: InboxEventFrame, handlers: InboxEventHandlers) => void;
  /** The lines after `cursor` up to now, as frames, from a request that ends (`once=1`): a tab's catch-up. */
  catchUp: (cursor: number) => Promise<InboxEventFrame[]>;
  /** Tell the server a window is gone (`unloading`: from pagehide, where only a beacon is sure to leave). */
  sendGone: (windowId: string, unloading: boolean) => void;
  /** Where `freeze`, `resume` (document) and `pagehide`, `pageshow` (window) arrive; null in tests that drive them. */
  lifecycle: { document: EventTarget; window: EventTarget } | null;
  /** Whether the person can see this tab (a visible follower checks on the leader more often). Default: never. */
  isVisible?: () => boolean;
  /** Test knobs for the leader check and the catch-up retry (defaults above). */
  timing?: { pingEveryMs?: number; hiddenPingEveryMs?: number; pongTimeoutMs?: number; retryMs?: number; retryMaxMs?: number };
}

export function sharedInboxEventsSupported(): boolean {
  try {
    return (
      typeof BroadcastChannel === 'function' &&
      typeof navigator !== 'undefined' &&
      typeof navigator.locks?.request === 'function' &&
      typeof EventSource === 'function'
    );
  } catch {
    return false;
  }
}

/** The page's own early channel (`prepareInboxEvents`) and what reached it before the subscription. */
let early: { channel: ChannelLike; frames: unknown[] } | null = null;
/** The live subscription, for `inboxEventsServedBy`. */
let active: { servedBy: () => string | null } | null = null;

/**
 * Start listening on the channel before the first list read, so a frame the
 * leader passes on between that read and the subscription is not lost
 * (`subscribeInboxEvents` keeps the ones past the read's cursor).
 */
export function prepareInboxEvents(channel: (name: string) => ChannelLike = defaultChannel): void {
  if (early || !sharedInboxEventsSupported()) return;
  const frames: unknown[] = [];
  const opened = channel(EVENTS_CHANNEL);
  opened.onmessage = (event) => {
    if (frames.length < EARLY_FRAMES_MAX) frames.push(event.data);
  };
  early = { channel: opened, frames };
}

/** The first list read failed: no subscription follows, so the early channel closes. */
export function discardPreparedInboxEvents(): void {
  if (!early) return;
  try {
    early.channel.onmessage = null;
    early.channel.close();
  } catch {
    // Already closed.
  }
  early = null;
}

/** The leader whose stream serves this tab, for the window's report (`served_by`); null when this tab leads or knows none. */
export function inboxEventsServedBy(): string | null {
  return active?.servedBy() ?? null;
}

function defaultChannel(name: string): ChannelLike {
  return new BroadcastChannel(name) as unknown as ChannelLike;
}

function defaultSendGone(windowId: string, unloading: boolean): void {
  const body = JSON.stringify({ window: windowId, gone: true });
  try {
    if (unloading && typeof navigator.sendBeacon === 'function') {
      if (navigator.sendBeacon('/api/inbox/window', new Blob([body], { type: 'application/json' }))) return;
    }
  } catch {
    // Fall through to fetch.
  }
  void fetch('/api/inbox/window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}

/** Read an event-stream body into its named frames. */
export function parseEventStreamText(text: string): InboxEventFrame[] {
  const frames: InboxEventFrame[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let name = 'message';
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':') || line === '') continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length === 0) continue;
    if ((INBOX_EVENT_FRAME_NAMES as readonly string[]).includes(name)) frames.push({ name: name as InboxEventFrame['name'], data: data.join('\n'), id });
  }
  return frames;
}
const INBOX_EVENT_FRAME_NAMES = ['hello', 'record', 'status', 'reach', 'deliveries', 'drafts', 'pins'] as const;

async function defaultCatchUp(cursor: number): Promise<InboxEventFrame[]> {
  const res = await fetch(`/api/inbox/events?cursor=${cursor}&once=1`, { headers: { Accept: 'text/event-stream' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`catch-up: ${res.status}`);
  return parseEventStreamText(await res.text());
}

/** The page's own pieces, with the stream and the dispatcher from api.ts. */
export function browserSharedEventsEnv(pieces: Pick<SharedEventsEnv, 'open' | 'dispatch'>): SharedEventsEnv {
  return {
    locks: navigator.locks as unknown as LockManagerLike,
    channel: defaultChannel,
    catchUp: defaultCatchUp,
    sendGone: defaultSendGone,
    lifecycle: { document, window },
    isVisible: () => document.visibilityState === 'visible',
    ...pieces,
  };
}

type Via = 'stream' | 'channel' | 'catch-up';

/**
 * A test's log of what this tab did (`window.__plannotatorInboxEventLog`, an
 * array a browser proof puts there before the page's own code): the cursor it
 * subscribed at, each record it handled (and how it came), when it led and
 * stopped leading. Nothing is logged without that array.
 */
function trace(entry: Record<string, unknown>): void {
  const log = (globalThis as { __plannotatorInboxEventLog?: unknown }).__plannotatorInboxEventLog;
  if (Array.isArray(log)) log.push({ ...entry, at: Date.now() });
}

function recordSeq(frame: InboxEventFrame): number | null {
  if (frame.name !== 'record') return null;
  const fromId = frame.id !== null && /^\d+$/.test(frame.id) ? Number(frame.id) : null;
  if (fromId !== null && Number.isSafeInteger(fromId)) return fromId;
  try {
    const seq = (JSON.parse(frame.data) as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : null;
  } catch {
    return null;
  }
}

function isMessage(value: unknown): value is SharedEventsMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  if (m.v !== 1 || typeof m.type !== 'string') return false;
  if (m.type === 'frame') {
    const f = m.frame as Record<string, unknown> | null;
    return typeof m.leader === 'string' && !!f && typeof f.name === 'string' && typeof f.data === 'string' && (f.id === null || typeof f.id === 'string');
  }
  if (m.type === 'leader') {
    return typeof m.window === 'string' && typeof m.from === 'number' && Number.isSafeInteger(m.from) && (m.to === undefined || typeof m.to === 'string');
  }
  if (m.type === 'join') return typeof m.window === 'string';
  if (m.type === 'ping') return typeof m.window === 'string' && typeof m.nonce === 'string';
  if (m.type === 'pong') return typeof m.leader === 'string' && typeof m.to === 'string' && typeof m.nonce === 'string';
  return false;
}

/**
 * Subscribe this tab through the shared stream: it leads when it holds the
 * lock, follows otherwise. Answers the unsubscribe.
 *
 * A leader whose main thread stops without a `freeze` (a debugger, a long
 * script in an attached page's frame, a phone's browser suspending a
 * background tab) keeps its lock and passes nothing on. So a follower the
 * person can see asks the leader every few seconds (and when it becomes
 * visible or gets focus), a hidden one every fifteen; a leader answers from
 * its message handler. No answer in time: the follower takes the lock
 * (`steal`) and leads. The old leader
 * learns it lost the lock when it runs again, closes its stream and follows.
 * Records the two pass on meanwhile are told apart by seq.
 */
export function subscribeSharedInboxEvents(
  cursor: number,
  handlers: InboxEventHandlers,
  win: InboxEventWindow,
  env: SharedEventsEnv,
): () => void {
  const pingEveryMs = env.timing?.pingEveryMs ?? LEADER_PING_EVERY_MS;
  const hiddenPingEveryMs = env.timing?.hiddenPingEveryMs ?? LEADER_HIDDEN_PING_EVERY_MS;
  const pongTimeoutMs = env.timing?.pongTimeoutMs ?? LEADER_PONG_TIMEOUT_MS;
  const retryMs = env.timing?.retryMs ?? CATCH_UP_RETRY_MS;
  const retryMaxMs = env.timing?.retryMaxMs ?? CATCH_UP_RETRY_MAX_MS;
  const isVisible = env.isVisible ?? (() => false);

  let lastSeq = cursor;
  let leader: string | null = null;
  let leading = false;
  let stopped = false;
  /** Frozen, or in the back/forward cache: not a candidate, not the leader. */
  let suspended = false;
  let closeStream: (() => void) | null = null;
  let releaseLeader: (() => void) | null = null;
  let queued: AbortController | null = null;
  /** A steal in flight (this tab found the leader not answering). */
  let stealing = false;
  /** The lock grant this tab leads under: a rejection of that grant means another tab took the lock. */
  let tenure: object | null = null;
  let releaseWindowLock: (() => void) | null = null;
  /** The seq this tab's stream started after, while it leads (`from` in its announcements). */
  let ledFrom = 0;
  const watched = new Map<string, AbortController>();
  /** Fetching what this tab missed: frames that arrive meanwhile wait, so records stay in order. */
  let catching = false;
  /** A catch-up failed (the Inbox restarting): frames keep waiting, and it is tried again (a timer, the next hello). */
  let behind = false;
  /** Another catch-up was asked for while one ran. */
  let again = false;
  let held: { frame: InboxEventFrame; via: Via }[] = [];
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = retryMs;
  /** The leader check in flight: a ping waiting for its pong. */
  let check: { nonce: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  /** When this tab last checked (a hidden tab checks every `hiddenPingEveryMs` only). */
  let lastCheckAt = Date.now();

  let channel: ChannelLike;
  let backlog: unknown[] = [];
  if (early && env.channel === defaultChannel) {
    channel = early.channel;
    backlog = early.frames;
    early = null;
  } else {
    channel = env.channel(EVENTS_CHANNEL);
  }
  const post = (message: SharedEventsMessage) => {
    try {
      channel.postMessage(message);
    } catch {
      // A closed channel: nothing to tell.
    }
  };

  /** Keep a frame until the catch-up lands. Past the cap, the oldest records go: the catch-up fetches them again. */
  const hold = (frame: InboxEventFrame, via: Via) => {
    held.push({ frame, via });
    if (held.length <= EARLY_FRAMES_MAX) return;
    const at = held.findIndex((item) => item.frame.name === 'record');
    held.splice(at >= 0 ? at : 0, 1);
  };

  /** One frame to this tab's handlers, a record once (by seq); held while a catch-up runs or is owed. */
  const deliver = (frame: InboxEventFrame, via: Via) => {
    if (stopped) return;
    if (frame.name === 'hello' && behind && !catching && !leading) void catchUp();
    if ((catching || behind) && via !== 'catch-up') {
      hold(frame, via);
      return;
    }
    const seq = recordSeq(frame);
    if (seq !== null) {
      if (seq <= lastSeq) return;
      lastSeq = seq;
      trace({ type: 'record', seq, via });
    }
    env.dispatch(frame, handlers);
  };

  const clearRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  };

  /** Fetch the lines after this tab's last seq (it slept, or its leader started past it), then what waited. */
  const catchUp = async (): Promise<void> => {
    if (stopped) return;
    if (catching) {
      // A new reason while one runs (another leader since): fetch again once it ends, still holding.
      again = true;
      return;
    }
    catching = true;
    clearRetry();
    let failed = false;
    try {
      const frames = await env.catchUp(lastSeq);
      if (stopped) return;
      behind = false;
      retryDelay = retryMs;
      for (const frame of frames) if (frame.name === 'record') deliver(frame, 'catch-up');
    } catch {
      failed = true;
    } finally {
      catching = false;
      if (failed && !stopped && !leading) {
        // Keep holding: delivering the held frames now would move the last seq past the gap, and the gap would never be fetched.
        behind = true;
        again = false;
        trace({ type: 'catch-up-failed', retryInMs: retryDelay });
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (behind && !leading) void catchUp();
        }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, retryMaxMs);
      } else if (again && !stopped && !leading) {
        again = false;
        void catchUp();
      } else if (!stopped) {
        // Done, or this tab leads now: its own stream replays every line after its last seq, so nothing is owed.
        again = false;
        if (leading) behind = false;
        const waiting = held;
        held = [];
        for (const item of waiting) deliver(item.frame, item.via);
      }
    }
  };

  /**
   * A new leader serves this tab: fetch the lines between this tab's last seq
   * and now first (the new leader's stream may have started past them: this
   * tab slept, or its list read was older than the stream), holding the
   * leader's frames until then; and report again, so the server counts this
   * tab under that leader.
   */
  const setLeader = (id: string | null): boolean => {
    if (id === leader) return false;
    leader = id;
    if (id !== null && id !== win.id && !stopped) {
      void catchUp();
      handlers.onConnect?.();
    }
    return true;
  };

  const watch = (follower: string) => {
    if (follower === win.id || watched.has(follower)) return;
    const abort = new AbortController();
    watched.set(follower, abort);
    env.locks
      .request(WINDOW_LOCK_PREFIX + follower, { signal: abort.signal }, () => {
        // Granted: that tab released its lock, so it is gone (closed, crashed, navigated).
        watched.delete(follower);
        if (leading && !abort.signal.aborted) env.sendGone(follower, false);
      })
      .catch(() => {
        watched.delete(follower);
      });
  };
  const unwatchAll = () => {
    for (const abort of watched.values()) abort.abort();
    watched.clear();
  };

  const lead = (how: 'queue' | 'steal') => {
    leading = true;
    leader = win.id;
    ledFrom = lastSeq;
    // This tab's own stream replays every line after its last seq: nothing owed, and what it held (another
    // leader's frames) comes again in order. Kept, they could move the last seq past lines its stream has yet to replay.
    behind = false;
    clearRetry();
    held = [];
    cancelCheck();
    trace({ type: 'lead', from: ledFrom, how });
    post({ v: 1, type: 'leader', window: win.id, from: ledFrom });
    closeStream = env.open(lastSeq, (frame) => {
      if (!leading) return;
      post({ v: 1, type: 'frame', leader: win.id, frame });
      deliver(frame, 'stream');
    }, win);
  };

  const stepDown = () => {
    tenure = null;
    if (leading) {
      leading = false;
      trace({ type: 'step-down' });
      closeStream?.();
      closeStream = null;
      unwatchAll();
      leader = null;
    }
    releaseLeader?.();
    releaseLeader = null;
  };

  /** Ask for the stream's lock: in line behind the leader, or (`steal`) at once, taking it from a leader that does not answer. */
  const acquire = (steal: boolean) => {
    if (stopped || suspended || leading) return;
    if (steal) {
      if (stealing) return;
      stealing = true;
      queued?.abort();
      queued = null;
    } else if (queued || stealing) {
      return;
    }
    const abort = steal ? null : new AbortController();
    if (abort) queued = abort;
    const token = {};
    env.locks
      .request(EVENTS_LOCK, abort ? { signal: abort.signal } : { steal: true }, () => {
        if (abort && queued === abort) queued = null;
        if (steal) stealing = false;
        if (stopped || suspended || abort?.signal.aborted || leading) return undefined;
        tenure = token;
        lead(steal ? 'steal' : 'queue');
        return new Promise<void>((release) => {
          releaseLeader = release;
        });
      })
      .catch(() => {
        if (abort && queued === abort) queued = null;
        if (steal) stealing = false;
        if (tenure !== token) return;
        // Another tab took the lock while this one did not answer (it was paused): follow that tab.
        trace({ type: 'stolen' });
        stepDown();
        if (stopped || suspended) return;
        post({ v: 1, type: 'join', window: win.id });
        acquire(false);
        void catchUp();
      });
  };
  const queueForLeader = () => acquire(false);

  /** A leader answered (or passed something on): its main thread runs. */
  const cancelCheck = () => {
    if (!check) return;
    clearTimeout(check.timer);
    check = null;
  };
  /** A follower asks the leader whether it is alive; no answer in time, it takes the stream. */
  const checkLeader = () => {
    if (stopped || suspended || leading || stealing || check) return;
    if (!isVisible() && Date.now() - lastCheckAt < hiddenPingEveryMs) return;
    lastCheckAt = Date.now();
    const nonce = Math.random().toString(36).slice(2, 12);
    const timer = setTimeout(() => {
      if (check?.nonce !== nonce) return;
      check = null;
      if (stopped || suspended || leading) return;
      trace({ type: 'steal', from: leader });
      acquire(true);
    }, pongTimeoutMs);
    check = { nonce, timer };
    post({ v: 1, type: 'ping', window: win.id, nonce });
  };

  const onMessage = (data: unknown) => {
    if (stopped || !isMessage(data)) return;
    if (data.type === 'frame') {
      if (data.leader !== win.id && !leading) {
        cancelCheck();
        // Frames name the leader only for a tab that knows none (a stale leader's last frames must not take the tab back).
        if (leader === null) setLeader(data.leader);
      }
      deliver(data.frame, 'channel');
      return;
    }
    if (data.type === 'ping') {
      if (leading && data.window !== win.id) post({ v: 1, type: 'pong', leader: win.id, to: data.window, nonce: data.nonce });
      return;
    }
    if (data.type === 'pong') {
      if (data.to !== win.id || leading) return;
      if (check?.nonce === data.nonce) cancelCheck();
      if (leader === null) setLeader(data.leader);
      return;
    }
    if (data.type === 'leader') {
      if (data.window === win.id || leading) return;
      cancelCheck();
      setLeader(data.window);
      // A new leader's announcement: tell it this tab is here (it watches this tab's lock and answers this tab only).
      if (data.to === undefined) post({ v: 1, type: 'join', window: win.id });
      return;
    }
    if (data.type === 'join') {
      if (!leading || data.window === win.id) return;
      watch(data.window);
      post({ v: 1, type: 'leader', window: win.id, from: ledFrom, to: data.window });
    }
  };
  trace({ type: 'subscribe', cursor, window: win.id });
  // Live before the backlog: a frame that reached the early channel names the
  // leader, and the report that follows (`onConnect`) reads `served_by` from
  // here. Set after it, that report named no leader, the leader's own answer
  // then changed nothing, and the server never counted this tab.
  const self = { servedBy: () => (leading ? null : leader) };
  active = self;
  channel.onmessage = (event) => onMessage(event.data);
  for (const data of backlog) onMessage(data);
  backlog = [];

  // This tab's own lock first (the leader watches it), then join and queue for the stream.
  void env.locks
    .request(WINDOW_LOCK_PREFIX + win.id, {}, () => {
      if (stopped) return undefined;
      return new Promise<void>((release) => {
        releaseWindowLock = release;
        if (stopped) {
          release();
          return;
        }
        post({ v: 1, type: 'join', window: win.id });
        queueForLeader();
      });
    })
    .catch(() => {
      // No lock for this tab: it can still lead and follow; a crash is then seen by the server's grace only.
      if (!stopped) {
        post({ v: 1, type: 'join', window: win.id });
        queueForLeader();
      }
    });

  const suspend = () => {
    if (suspended) return;
    suspended = true;
    cancelCheck();
    stepDown();
    queued?.abort();
    queued = null;
  };
  const wake = () => {
    if (!suspended || stopped) return;
    suspended = false;
    leader = null;
    post({ v: 1, type: 'join', window: win.id });
    queueForLeader();
    // Whatever the leader passed on while this tab slept may be gone: fetch from its last seq.
    void catchUp();
    checkLeader();
  };
  const onFreeze = () => suspend();
  const onResume = () => wake();
  const onPageHide = (event: Event) => {
    // Leaving for good, or for the back/forward cache: either way this tab stops counting now.
    env.sendGone(win.id, true);
    if ((event as PageTransitionEvent).persisted) suspend();
    else stepDown();
  };
  const onPageShow = (event: Event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    wake();
    // The server heard `gone` at pagehide: count this tab again.
    handlers.onConnect?.();
  };
  const onVisible = () => {
    if (isVisible()) checkLeader();
  };
  env.lifecycle?.document.addEventListener('freeze', onFreeze);
  env.lifecycle?.document.addEventListener('resume', onResume);
  env.lifecycle?.document.addEventListener('visibilitychange', onVisible);
  env.lifecycle?.window.addEventListener('pagehide', onPageHide);
  env.lifecycle?.window.addEventListener('pageshow', onPageShow);
  env.lifecycle?.window.addEventListener('focus', onVisible);
  pingTimer = setInterval(checkLeader, pingEveryMs);

  return () => {
    if (stopped) return;
    stopped = true;
    cancelCheck();
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    clearRetry();
    stepDown();
    queued?.abort();
    queued = null;
    releaseWindowLock?.();
    releaseWindowLock = null;
    env.lifecycle?.document.removeEventListener('freeze', onFreeze);
    env.lifecycle?.document.removeEventListener('resume', onResume);
    env.lifecycle?.document.removeEventListener('visibilitychange', onVisible);
    env.lifecycle?.window.removeEventListener('pagehide', onPageHide);
    env.lifecycle?.window.removeEventListener('pageshow', onPageShow);
    env.lifecycle?.window.removeEventListener('focus', onVisible);
    channel.onmessage = null;
    channel.close();
    if (active === self) active = null;
  };
}
