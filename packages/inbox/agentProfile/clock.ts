/**
 * One clock for every duration an agent's line shows ("Working · 3m"): a single one-second timer while at least one
 * line on screen counts, and none otherwise. A line draws again only when its own words change (the snapshot is the
 * words), so a minute-long duration draws once a minute.
 */
import { useSyncExternalStore } from 'react';
import { durationWords } from './line';

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) timer = setInterval(() => listeners.forEach((l) => l()), TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const none = () => () => {};

/** How long since `from` ("12s", "3m"), kept current while drawn; "" for none. */
export function useDurationSince(from: string | null): string {
  const read = () => {
    const at = from ? Date.parse(from) : Number.NaN;
    return Number.isFinite(at) ? durationWords(Date.now() - at) : '';
  };
  return useSyncExternalStore(from ? subscribe : none, read, read);
}

/** Tests: whether the clock runs now (nothing on screen counts: it must not). */
export function agentClockRunning(): boolean {
  return timer !== null;
}
