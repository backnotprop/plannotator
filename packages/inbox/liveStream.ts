/** A connection can die without closing, so the EventSource stays open and looks like a quiet Inbox. When no frame (heartbeat included) arrives for STREAM_STALE_MS, reconnect and catch up; if no frame follows within DEAD_NOTE_DELAY_MS, report the stream dead. */

export const STREAM_STALE_MS = 25_000;
export const DEAD_NOTE_DELAY_MS = 3_000;
/** A check that runs this much past its time ran after a sleep (or held-back timers): it waits the grace first. */
export const LATE_CHECK_MS = 3_000;

export interface LiveStreamHooks {
  reconnect: () => void;
  catchUp: () => void;
  onLive: (live: boolean) => void;
}

export interface LiveStreamTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}

export interface LiveStreamEnv {
  isVisible?: () => boolean;
  lifecycle: { document: EventTarget; window: EventTarget } | null;
  staleMs?: () => number;
  deadNoteDelayMs?: number;
  timers?: LiveStreamTimers;
  graceLate?: () => boolean;
}

export interface LiveStreamWatch {
  heard: () => void;
  restart: () => void;
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
  let lastAttempt: number | null = null;
  let live = true;
  let stopped = false;
  let checkTimer: unknown = null;
  let dueAt = 0;
  let graced = false;
  let noteTimer: unknown = null;

  const silentFrom = () => Math.max(lastHeard, lastAttempt ?? 0);

  const setCheck = (ms: number) => {
    if (stopped) return;
    if (checkTimer !== null) timers.clearTimeout(checkTimer);
    dueAt = Date.now() + ms;
    checkTimer = timers.setTimeout(check, ms);
  };
  const schedule = () => setCheck(Math.max(0, silentFrom() + staleMs() - Date.now()));
  const grace = () => {
    if (!graceLate()) {
      actOnSilence();
      return;
    }
    graced = true;
    setCheck(noteDelayMs);
  };

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
