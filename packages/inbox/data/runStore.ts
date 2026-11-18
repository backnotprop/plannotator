/**
 * A message's Run and Secret state, shared by every `:::run` and `:::secret` card of that message: one read, then a
 * poll for as long as a card of it is on screen and the window is visible. While a command starts or runs anywhere
 * (here, from a phone, in another window) the poll is quick, so its output and its end show as they come; while
 * nothing runs it is slow, so a run pressed elsewhere still shows up here. A read goes through the same routes from
 * the computer, a phone or a linked machine, so each sees the same live card.
 *
 * The poll belongs to the message's entry, not to a card's render: a card redrawing (which unsubscribes and
 * subscribes again) never stops it. It stops when the last card of the message has been gone for a moment.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { runApi, type RunStateWire } from './runApi';

/** How often a card reads while a command starts or runs. */
export const RUN_POLL_MS = 500;
/** How often a card on screen reads while nothing runs (a run started on another device). */
export const RUN_IDLE_POLL_MS = 3_000;

type Snapshot = { state: RunStateWire | null; error: string | null };

interface Entry {
  messageId: string;
  state: RunStateWire | null;
  error: string | null;
  /** What cards draw: replaced on every change, so each change redraws them. */
  snapshot: Snapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  /** A read was asked for while one was on its way (a press): read again when it lands. */
  again: boolean;
  /** Stable for React: the same functions for every render of every card of this message. */
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Snapshot;
}

const entries = new Map<string, Entry>();

const busy = (state: RunStateWire | null) => !!state && Object.values(state.runs).some((run) => run.state === 'starting' || run.state === 'running');
const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

const tell = (entry: Entry) => {
  entry.snapshot = { state: entry.state, error: entry.error };
  for (const listener of entry.listeners) listener();
};

/** The next read, when a card shows the message and the window is visible; at most one waits. */
const schedule = (entry: Entry) => {
  if (entry.timer || entry.reading || entry.listeners.size === 0 || !visible()) return;
  entry.timer = setTimeout(
    () => {
      entry.timer = null;
      void read(entry);
    },
    busy(entry.state) ? RUN_POLL_MS : RUN_IDLE_POLL_MS,
  );
};

const stopPolling = (entry: Entry) => {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
};

async function read(entry: Entry): Promise<void> {
  stopPolling(entry);
  if (entry.reading) {
    entry.again = true;
    return;
  }
  entry.reading = true;
  try {
    entry.state = await runApi.state(entry.messageId);
    entry.error = null;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    entry.reading = false;
  }
  tell(entry);
  if (entry.again) {
    entry.again = false;
    return read(entry);
  }
  schedule(entry);
}

const entryOf = (messageId: string): Entry => {
  let entry = entries.get(messageId);
  if (entry) return entry;
  const made: Entry = {
    messageId,
    state: null,
    error: null,
    snapshot: { state: null, error: null },
    listeners: new Set(),
    timer: null,
    reading: false,
    again: false,
    subscribe: (listener) => {
      const first = made.listeners.size === 0;
      made.listeners.add(listener);
      if (first) {
        if (made.state === null && !made.reading) void read(made);
        else schedule(made);
      }
      return () => {
        made.listeners.delete(listener);
        // A redraw unsubscribes and subscribes again at once: the poll stops only when no card came back.
        if (made.listeners.size === 0) {
          setTimeout(() => {
            if (made.listeners.size === 0) stopPolling(made);
          }, 0);
        }
      };
    },
    getSnapshot: () => made.snapshot,
  };
  entries.set(messageId, made);
  return made;
};

/** Read the message's state now (after a press), then keep polling while a card shows it. */
export async function refreshRunState(messageId: string): Promise<void> {
  return read(entryOf(messageId));
}

/** Read every message a card shows now: a secret saved on one card shows on the others at once. */
export async function refreshAllRunStates(): Promise<void> {
  await Promise.all([...entries.values()].filter((entry) => entry.listeners.size > 0).map((entry) => read(entry)));
}

// The window coming back: read what changed while it was away, then the poll goes on.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const back = () => {
    if (!visible()) return;
    for (const entry of entries.values()) if (entry.listeners.size > 0) void read(entry);
  };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
}

/** The state a card draws. */
export function useRunState(messageId: string): Snapshot {
  const entry = entryOf(messageId);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  // A card that mounts while a command runs (a thread opened mid-run) reads at once.
  useEffect(() => {
    if (busy(entry.state)) void read(entry);
  }, [entry]);
  return snapshot;
}

/** For a test: forget every message's state and stop every poll. */
export function resetRunStateForTests(): void {
  for (const entry of entries.values()) stopPolling(entry);
  entries.clear();
}
