/**
 * Whether this tab still hears the Inbox's live stream.
 *
 * A connection can die without closing: a laptop wakes on another network, a
 * proxy holds the stream back, a background tab's socket is dropped. The
 * EventSource then stays "open" and the page looks exactly like a quiet
 * Inbox, so a thread stops updating until a reload. The server sends a
 * window's stream a heartbeat (`event: heartbeat`, every
 * `INBOX_WINDOW_HEARTBEAT_MS` in packages/server/inbox.ts, 10 s), and this
 * watch hears every frame. Nothing heard for the window (`STREAM_STALE_MS`,
 * 25 s: two and a half heartbeats, so one late beat is never a death):
 *
 * - it reconnects (`reconnect`: the leader opens its stream again; a follower
 *   takes the stream, see sharedEvents.ts);
 * - it catches up (`catchUp`: the page reads what a record makes it read),
 *   once per silent window;
 * - when the reconnect has not brought a frame within `DEAD_NOTE_DELAY_MS`,
 *   the stream is dead (`onLive(false)`) and the list says "Reconnecting…".
 *   A reconnect that works at once (the usual case) shows nothing.
 *
 * The next frame makes it live again (`onLive(true)`). While it stays silent
 * it reconnects and catches up once per window. A check that runs far past
 * its time (`LATE_CHECK_MS`: the computer slept, or a hidden tab's timers
 * were held back) waits a short grace first, so the first frame after a wake
 * can still arrive; so does a tab shown again, or back `online`, with the
 * stream silent past the window. A tab shown while the stream is dead
 * catches up at once; one back online while dead reconnects at once.
 *
 * While the stream is healthy this requests nothing, hidden or shown: a frame
 * only moves a timestamp, and the one timer fires once per window.
 */

/** The silence after which the stream counts as dead. */
export const STREAM_STALE_MS = 25_000;
/** How long a reconnect has to bring a frame before the list says "Reconnecting…"; also the grace after a late check. */
export const DEAD_NOTE_DELAY_MS = 3_000;
/** A check that runs this much past its time ran after a sleep (or held-back timers): it waits the grace first. */
export const LATE_CHECK_MS = 3_000;

export interface LiveStreamHooks {
  /** Open the stream again (or take it from the tab that holds it). */
  reconnect: () => void;
  /** Read again what a record makes the page read (the list, the open thread…). */
  catchUp: () => void;
  /** The stream is dead (`false`) or heard again (`true`). Called on a change only. */
  onLive: (live: boolean) => void;
}

export interface LiveStreamTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface LiveStreamEnv {
  /** Whether the person can see this tab. Default: always. */
  isVisible?: () => boolean;
  /** Where `visibilitychange` (document) and `online` (window) arrive; null where nothing drives them. */
  lifecycle: { document: EventTarget; window: EventTarget } | null;
  /** The silence window, read at each check (a follower waits a little longer than its leader). Default `STREAM_STALE_MS`. */
  staleMs?: () => number;
  /** Default `DEAD_NOTE_DELAY_MS`. */
  deadNoteDelayMs?: number;
  /** The page's timers by default; a test passes a tab whose timers the browser holds back. */
  timers?: LiveStreamTimers;
  /**
   * Whether a late check (or a show, or `online`) waits the grace before acting. Default: always. A leader acts at
   * once (reopening its own stream costs nothing, and its announcement tells the followers in their grace).
   */
  graceLate?: () => boolean;
}

export interface LiveStreamWatch {
  /** A frame arrived from the stream (the tab's own, or its leader's). */
  heard: () => void;
  /** Start the window again from now (a tab that slept and woke up, or started following another tab). */
  restart: () => void;
  /** The window's length changed (a follower came to lead): set the timer again, the silence kept. */
  rearm: () => void;
  stop: () => void;
}

const pageTimers: LiveStreamTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function watchLiveStream(hooks: LiveStreamHooks, env: LiveStreamEnv): LiveStreamWatch {
  const staleMs = env.staleMs ?? (() => STREAM_STALE_MS);
  const noteDelayMs = env.deadNoteDelayMs ?? DEAD_NOTE_DELAY_MS;
  const isVisible = env.isVisible ?? (() => true);
  const timers = env.timers ?? pageTimers;
  const graceLate = env.graceLate ?? (() => true);
  let lastHeard = Date.now();
  /** When the silence was last acted on (reconnect and catch-up): the next attempt waits a window after it. */
  let lastAttempt: number | null = null;
  let live = true;
  let stopped = false;
  let checkTimer: unknown = null;
  /** When the pending check is due (a check that runs far past it ran after a sleep). */
  let dueAt = 0;
  /** The pending check is the grace after a late one (or a show, or `online`): it acts however late it runs. */
  let graced = false;
  let noteTimer: unknown = null;

  /** Since when the stream counts as silent: the last frame, or the last attempt (one attempt per window). */
  const silentFrom = () => Math.max(lastHeard, lastAttempt ?? 0);

  const setCheck = (ms: number) => {
    if (stopped) return;
    if (checkTimer !== null) timers.clearTimeout(checkTimer);
    dueAt = Date.now() + ms;
    checkTimer = timers.setTimeout(check, ms);
  };
  const schedule = () => setCheck(Math.max(0, silentFrom() + staleMs() - Date.now()));
  /** Silent past the window, but give the stream a moment (a frame on its way after a wake) before acting. */
  const grace = () => {
    if (!graceLate()) {
      actOnSilence();
      return;
    }
    graced = true;
    setCheck(noteDelayMs);
  };

  /** Silent for the window: reconnect, catch up, and say it once the reconnect has had its moment. */
  const actOnSilence = () => {
    graced = false;
    lastAttempt = Date.now();
    hooks.reconnect();
    hooks.catchUp();
    if (live && noteTimer === null) {
      noteTimer = timers.setTimeout(() => {
        noteTimer = null;
        if (stopped || !live || lastAttempt === null || lastHeard >= lastAttempt) return;
        live = false;
        hooks.onLive(false);
      }, noteDelayMs);
    }
    schedule();
  };

  function check(): void {
    checkTimer = null;
    if (stopped) return;
    const now = Date.now();
    if (now - silentFrom() < staleMs()) {
      graced = false;
      schedule();
      return;
    }
    if (!graced && now - dueAt > LATE_CHECK_MS) {
      grace();
      return;
    }
    actOnSilence();
  }

  const onVisibility = () => {
    if (stopped || !isVisible()) return;
    // Healthy (heard within the window, or already acted on in it): nothing to read.
    if (Date.now() - silentFrom() >= staleMs()) {
      if (!graced) grace();
    } else if (!live) hooks.catchUp();
  };
  const onOnline = () => {
    if (stopped) return;
    if (!live) actOnSilence();
    else if (Date.now() - silentFrom() >= staleMs() && !graced) grace();
  };
  env.lifecycle?.document.addEventListener('visibilitychange', onVisibility);
  env.lifecycle?.window.addEventListener('online', onOnline);
  schedule();

  return {
    heard: () => {
      if (stopped) return;
      lastHeard = Date.now();
      lastAttempt = null;
      if (noteTimer !== null) timers.clearTimeout(noteTimer);
      noteTimer = null;
      if (!live) {
        live = true;
        hooks.onLive(true);
      }
      // The timer already set fires at the old deadline and sets itself again from here: no timer per frame.
      if (checkTimer === null) schedule();
    },
    restart: () => {
      if (stopped) return;
      lastHeard = Date.now();
      lastAttempt = null;
      graced = false;
      schedule();
    },
    rearm: () => {
      if (!graced) schedule();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (checkTimer !== null) timers.clearTimeout(checkTimer);
      if (noteTimer !== null) timers.clearTimeout(noteTimer);
      checkTimer = null;
      noteTimer = null;
      env.lifecycle?.document.removeEventListener('visibilitychange', onVisibility);
      env.lifecycle?.window.removeEventListener('online', onOnline);
    },
  };
}
