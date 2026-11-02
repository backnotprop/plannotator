/**
 * Settings → Rows' Time "Relative" (listLook.ts `relativeTime`, approval "inbox-customize-rows"): a row's time as
 * "now", "4m", "3h", "2d", then the date as the clock form writes it (`shortTime`), so an old thread still reads
 * "Oct 19".
 *
 * Every row showing it reads one shared minute clock: a single timer for the whole Inbox, running only while some
 * row shows a relative time, instead of a timer per row.
 */
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

/** The shared minute clock's time; `active` false subscribes nothing (a clock-form row starts no timer). */
export function useRelativeClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : idle, snapshot, snapshot);
}
