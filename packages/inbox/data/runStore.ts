/**
 * A message's Run and Secret state, shared by every `:::run` and `:::secret` card of that message.
 *
 * What it costs: a card reads its state when it first comes on screen (a card scrolled far away reads nothing).
 * After that, nothing is read while nothing runs: this Inbox says when a card's state changed (`event: runs`,
 * data/runEvents.ts: a run started, ended or was stopped from any window or a phone; a secret saved or removed),
 * and the cards it names read again (at once when on screen, else when they come on screen). Only a card on
 * screen whose command is starting or running polls, every `RUN_POLL_MS`, for its output and its end. A message
 * on a linked machine (no event reaches this window from there) is read every `RUN_IDLE_POLL_MS` while its card is
 * on screen. Nothing is read while the window is hidden; the window coming back reads the cards on screen.
 *
 * The poll belongs to the message's entry, not to a card's render: a card redrawing (which unsubscribes and
 * subscribes again) never stops it. When the last card of a message has gone (its thread closed) the entry is
 * dropped, so a thread opened again reads fresh state and never shows an old one.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { machineOf } from '../inboxUrl';
import { runApi, type RunStateWire } from './runApi';
import { runEvents } from './runEvents';

/** How often a card on screen reads while its command starts or runs. */
export let RUN_POLL_MS = 500;
/** How often a card on screen reads a linked machine's message (its changes send no event here). */
export let RUN_IDLE_POLL_MS = 5_000;

type Snapshot = { state: RunStateWire | null; error: string | null };

interface Entry {
  messageId: string;
  state: RunStateWire | null;
  error: string | null;
  /** What cards draw: replaced on every change, so each change redraws them. */
  snapshot: Snapshot;
  listeners: Set<() => void>;
  /** Cards of this message on screen now. */
  onScreen: Set<Element>;
  /** Its state may have changed since it was last read (an event, or never read): read it when a card is on screen. */
  stale: boolean;
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
const seen = (entry: Entry) => entry.listeners.size > 0 && entry.onScreen.size > 0 && visible();

const tell = (entry: Entry) => {
  entry.snapshot = { state: entry.state, error: entry.error };
  for (const listener of entry.listeners) listener();
};

/** The next read: only for a card on screen in a visible window, and only while it runs (or on a linked machine). */
const schedule = (entry: Entry) => {
  if (entry.timer || entry.reading || !seen(entry)) return;
  const every = busy(entry.state) ? RUN_POLL_MS : machineOf(entry.messageId) ? RUN_IDLE_POLL_MS : null;
  if (every === null) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    // Hidden or scrolled away since: nothing (it reads when seen again).
    if (seen(entry)) void read(entry);
    else entry.stale = true;
  }, every);
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
  entry.stale = false;
  try {
    entry.state = await runApi.state(entry.messageId);
    entry.error = null;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    entry.reading = false;
  }
  // Dropped while it read (its thread closed): nothing to tell.
  if (entries.get(entry.messageId) !== entry) return;
  tell(entry);
  if (entry.again) {
    entry.again = false;
    return read(entry);
  }
  schedule(entry);
}

/** Read now when a card of it is on screen; otherwise when one comes on screen. */
const readWhenSeen = (entry: Entry) => {
  if (seen(entry)) void read(entry);
  else entry.stale = true;
};

const entryOf = (messageId: string): Entry => {
  let entry = entries.get(messageId);
  if (entry) return entry;
  const made: Entry = {
    messageId,
    state: null,
    error: null,
    snapshot: { state: null, error: null },
    listeners: new Set(),
    onScreen: new Set(),
    stale: true,
    timer: null,
    reading: false,
    again: false,
    subscribe: (listener) => {
      made.listeners.add(listener);
      return () => {
        made.listeners.delete(listener);
        // A redraw unsubscribes and subscribes again at once: the entry goes only when no card came back.
        if (made.listeners.size === 0) {
          setTimeout(() => {
            if (made.listeners.size > 0 || entries.get(messageId) !== made) return;
            stopPolling(made);
            entries.delete(messageId);
          }, 0);
        }
      };
    },
    getSnapshot: () => made.snapshot,
  };
  entries.set(messageId, made);
  return made;
};

/** Read the message's state now (after a press), then keep polling while a card shows it running. */
export async function refreshRunState(messageId: string): Promise<void> {
  return read(entryOf(messageId));
}

/**
 * Do a change every card may show (a secret saved or removed), then read every message a card shows: it shows on
 * the others at once. The Inbox's own `runs` event for that change, heard meanwhile, is not read a second time.
 */
let ownChangeUntil = 0;
export async function refreshAllRunStates(change?: () => Promise<unknown>): Promise<void> {
  if (change) {
    ownChangeUntil = Date.now() + 3_000;
    try {
      await change();
    } catch (failure) {
      ownChangeUntil = 0;
      throw failure;
    }
  }
  await Promise.all([...entries.values()].filter((entry) => entry.listeners.size > 0).map((entry) => read(entry)));
}

// This Inbox says a card's state changed: those cards read again (on screen now, the others when they come on screen).
runEvents.subscribe((change) => {
  if ('all' in change && Date.now() < ownChangeUntil) {
    // This window's own save: it reads every card itself once the save lands.
    ownChangeUntil = 0;
    return;
  }
  for (const entry of entries.values()) {
    if (entry.listeners.size === 0) continue;
    if ('all' in change || change.message_ids.includes(entry.messageId)) readWhenSeen(entry);
  }
});

// The window coming back: what changed while it was away is read for the cards on screen.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const back = () => {
    if (!visible()) return;
    for (const entry of entries.values()) if (entry.listeners.size > 0) readWhenSeen(entry);
  };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
}

/** One observer for every card: which are on screen (a little beyond, so a card scrolled to has its state). */
let observer: IntersectionObserver | null = null;
const cardEntry = new WeakMap<Element, Entry>();
const watchCards = (): IntersectionObserver | null => {
  if (observer || typeof IntersectionObserver === 'undefined') return observer;
  observer = new IntersectionObserver(
    (changes) => {
      for (const change of changes) {
        const entry = cardEntry.get(change.target);
        if (!entry) continue;
        if (change.isIntersecting) {
          const first = entry.onScreen.size === 0;
          entry.onScreen.add(change.target);
          if (first && (entry.stale || busy(entry.state))) void read(entry);
          else schedule(entry);
        } else {
          entry.onScreen.delete(change.target);
          if (entry.onScreen.size === 0) stopPolling(entry);
        }
      }
    },
    { rootMargin: '200px 0px' },
  );
  return observer;
};

/** The state a card draws, and the ref its root element takes so the store knows when it is on screen. */
export function useRunState(messageId: string): Snapshot & { cardRef: (element: Element | null) => (() => void) | undefined } {
  const entry = entryOf(messageId);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const cardRef = useCallback(
    (element: Element | null) => {
      if (!element) return undefined;
      const io = watchCards();
      cardEntry.set(element, entry);
      if (io) io.observe(element);
      else {
        // No IntersectionObserver (an old browser, a test DOM): every card counts as on screen.
        entry.onScreen.add(element);
        if (entry.stale || busy(entry.state)) void read(entry);
      }
      // The card leaves the page: it is no longer on screen.
      return () => {
        io?.unobserve(element);
        entry.onScreen.delete(element);
        if (entry.onScreen.size === 0) stopPolling(entry);
      };
    },
    [entry],
  );
  // A card that mounts while a command runs (a thread opened mid-run) polls at once.
  useEffect(() => {
    if (busy(entry.state)) schedule(entry);
  }, [entry]);
  return { ...snapshot, cardRef };
}

/** For a test: forget every message's state, stop every poll, and set how often cards poll. */
export function resetRunStateForTests(times: { poll?: number; idle?: number } = {}): void {
  for (const entry of entries.values()) stopPolling(entry);
  entries.clear();
  ownChangeUntil = 0;
  RUN_POLL_MS = times.poll ?? 500;
  RUN_IDLE_POLL_MS = times.idle ?? 5_000;
}

/** For a test: how many messages the store holds now. */
export const runStateEntriesForTests = (): number => entries.size;
