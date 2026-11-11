import { useSyncExternalStore } from 'react';
import { shortTime } from './format';

export const RELATIVE_TICK_MS = 60_000;

export function relativeTime(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : shortTime(iso);
}

/** A screen reader would read "4m" as "4 meters": spell it out. */
export function relativeWords(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (minutes < 60) return ago(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, 'hour');
  const days = Math.floor(hours / 24);
  return days < 7 ? ago(days, 'day') : shortTime(iso);
}

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const each of listeners) each();
    }, RELATIVE_TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idle = () => () => {};
const snapshot = () => now;

export function useRelativeClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, snapshot, snapshot);
}
