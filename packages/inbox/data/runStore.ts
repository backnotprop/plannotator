/**
 * A message's Run and Secret state, shared by every `:::run` and `:::secret` card of that message: one read, and one
 * poll while a command starts or runs (its output arrives as it is read, about twice a second). A read goes through
 * the same routes from the computer, a phone or a linked machine, so each sees the same live card.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { runApi, type RunStateWire } from './runApi';

/** How often a running command's card reads its output. */
export const RUN_POLL_MS = 500;

interface Entry {
  state: RunStateWire | null;
  error: string | null;
  /** What cards draw: replaced on every change, so each change redraws them. */
  snapshot: { state: RunStateWire | null; error: string | null };
  listeners: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  reading: boolean;
  /** A read was asked for while one was on its way (a press): read again when it lands. */
  again: boolean;
}

const entries = new Map<string, Entry>();

const entryOf = (messageId: string): Entry => {
  let entry = entries.get(messageId);
  if (!entry) {
    entry = { state: null, error: null, snapshot: { state: null, error: null }, listeners: new Set(), timer: null, reading: false, again: false };
    entries.set(messageId, entry);
  }
  return entry;
};

const busy = (state: RunStateWire | null) => !!state && Object.values(state.runs).some((run) => run.state === 'starting' || run.state === 'running');

const tell = (entry: Entry) => {
  entry.snapshot = { state: entry.state, error: entry.error };
  for (const listener of entry.listeners) listener();
};

/** Read the message's state now; while a command runs, again every RUN_POLL_MS for as long as a card shows it. */
export async function refreshRunState(messageId: string): Promise<void> {
  const entry = entryOf(messageId);
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.reading) {
    entry.again = true;
    return;
  }
  entry.reading = true;
  try {
    entry.state = await runApi.state(messageId);
    entry.error = null;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  } finally {
    entry.reading = false;
  }
  tell(entry);
  if (entry.again) {
    entry.again = false;
    return refreshRunState(messageId);
  }
  if (busy(entry.state) && entry.listeners.size > 0) entry.timer = setTimeout(() => void refreshRunState(messageId), RUN_POLL_MS);
}

/** The state a card draws; the first card of a message reads it. */
export function useRunState(messageId: string): { state: RunStateWire | null; error: string | null } {
  const entry = entryOf(messageId);
  const snapshot = useSyncExternalStore(
    (listener) => {
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = null;
        }
      };
    },
    () => entry.snapshot,
  );
  useEffect(() => {
    if (entry.state === null || busy(entry.state)) void refreshRunState(messageId);
    // A run pressed on another device shows here when the person comes back to this window.
    const back = () => {
      if (document.visibilityState === 'visible') void refreshRunState(messageId);
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
  }, [messageId]);
  return snapshot;
}

/** For a test: forget every message's state and stop every poll. */
export function resetRunStateForTests(): void {
  for (const entry of entries.values()) if (entry.timer) clearTimeout(entry.timer);
  entries.clear();
}
