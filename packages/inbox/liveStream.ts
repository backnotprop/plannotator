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
 * - it catches up (`catchUp`: the page reads the list and the open thread
 *   again, through the paths a record uses), once per silent window;
 * - when the reconnect has not brought a frame within `DEAD_NOTE_DELAY_MS`,
 *   the stream is dead (`onLive(false)`) and the list says "Reconnecting…".
 *   A reconnect that works at once (the usual case) shows nothing.
 *
 * The next frame makes it live again (`onLive(true)`). While it stays silent
 * it reconnects and catches up once per window. A tab shown again after it was
 * hidden for longer than the window, or a browser back `online` while the
 * stream was dead, catches up at once. While the stream is healthy this
 * requests nothing: a frame only moves a timestamp, and the one timer fires
 * once per window.
 */

/** The silence after which the stream counts as dead. */
export const STREAM_STALE_MS = 25_000;
/** How long a reconnect has to bring a frame before the list says "Reconnecting…". */
export const DEAD_NOTE_DELAY_MS = 3_000;

export interface LiveStreamHooks {
  /** Open the stream again (or take it from the tab that holds it). */
  reconnect: () => void;
  /** Read the list and the open thread again. */
  catchUp: () => void;
  /** The stream is dead (`false`) or heard again (`true`). Called on a change only. */
  onLive: (live: boolean) => void;
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

export function watchLiveStream(hooks: LiveStreamHooks, env: LiveStreamEnv): LiveStreamWatch {
  const staleMs = env.staleMs ?? (() => STREAM_STALE_MS);
  const noteDelayMs = env.deadNoteDelayMs ?? DEAD_NOTE_DELAY_MS;
  const isVisible = env.isVisible ?? (() => true);
  let lastHeard = Date.now();
  /** When the silence was last acted on (reconnect and catch-up): the next attempt waits a window after it. */
  let lastAttempt: number | null = null;
  let live = true;
  let stopped = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  let hiddenAt: number | null = isVisible() ? null : Date.now();

  const silentFor = () => Date.now() - lastHeard;

  const schedule = () => {
    if (stopped) return;
    if (checkTimer) clearTimeout(checkTimer);
    const from = Math.max(lastHeard, lastAttempt ?? 0);
    checkTimer = setTimeout(check, Math.max(0, from + staleMs() - Date.now()));
  };

  /** Silent for the window: reconnect, catch up, and say it once the reconnect has had its moment. */
  const actOnSilence = () => {
    lastAttempt = Date.now();
    hooks.reconnect();
    hooks.catchUp();
    if (live && !noteTimer) {
      noteTimer = setTimeout(() => {
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
    const from = Math.max(lastHeard, lastAttempt ?? 0);
    if (Date.now() - from >= staleMs()) actOnSilence();
    else schedule();
  }

  const onVisibility = () => {
    if (stopped) return;
    if (!isVisible()) {
      hiddenAt ??= Date.now();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (silentFor() >= staleMs()) actOnSilence();
    else if (!live || hiddenFor >= staleMs()) hooks.catchUp();
  };
  const onOnline = () => {
    if (stopped) return;
    if (!live || silentFor() >= staleMs()) actOnSilence();
    else if (hiddenAt !== null && Date.now() - hiddenAt >= staleMs()) hooks.catchUp();
  };
  env.lifecycle?.document.addEventListener('visibilitychange', onVisibility);
  env.lifecycle?.window.addEventListener('online', onOnline);
  schedule();

  return {
    heard: () => {
      if (stopped) return;
      lastHeard = Date.now();
      lastAttempt = null;
      if (noteTimer) clearTimeout(noteTimer);
      noteTimer = null;
      if (!live) {
        live = true;
        hooks.onLive(true);
      }
      // The timer already set fires at the old deadline and sets itself again from here: no timer per frame.
      if (!checkTimer) schedule();
    },
    restart: () => {
      if (stopped) return;
      lastHeard = Date.now();
      lastAttempt = null;
      schedule();
    },
    rearm: () => schedule(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (checkTimer) clearTimeout(checkTimer);
      if (noteTimer) clearTimeout(noteTimer);
      checkTimer = null;
      noteTimer = null;
      env.lifecycle?.document.removeEventListener('visibilitychange', onVisibility);
      env.lifecycle?.window.removeEventListener('online', onOnline);
    },
  };
}
