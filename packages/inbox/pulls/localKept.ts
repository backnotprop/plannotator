/**
 * What the person opened from "On this computer"'s + (approval "reviews-open-any-branch-a": "what you open stays in the
 * list"), kept in this browser as the list's folds are (`plannotator-inbox-reviews-folds`): the row keys
 * (`inboxLocalWorkKey`) and when each was opened, newest first, at most `INBOX_LOCAL_KEPT_MAX`. The list asks for them
 * with each read (`keep=`) and the server reads each again; a kept row then follows the group's own rules
 * (`keptShows`): it shows while it has work of its own, has had a commit or a change (or was opened) in the last 14
 * days and is in no PR; one with nothing beyond the default branch shows only while it is open.
 */
import { useSyncExternalStore } from 'react';
import { INBOX_LOCAL_KEPT_MAX, INBOX_UNREPORTED_BRANCH_DAYS, inboxLocalSameAsBase, type InboxLocalWork } from '@plannotator/core/inbox-types';

export const LOCAL_KEPT_KEY = 'plannotator-inbox-reviews-opened';

export interface KeptLocal {
  key: string;
  /** When the person opened it, ms. */
  at: number;
}

const NONE: readonly KeptLocal[] = [];
let cache: { raw: string | null; list: readonly KeptLocal[] } | null = null;
const listeners = new Set<() => void>();

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The kept list, newest first (unreadable or missing: none). */
export function readKeptLocal(): readonly KeptLocal[] {
  const raw = storage()?.getItem(LOCAL_KEPT_KEY) ?? null;
  if (cache && cache.raw === raw) return cache.list;
  let list: readonly KeptLocal[] = NONE;
  try {
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed)) list = parsed.filter((item): item is KeptLocal => !!item && typeof item.key === 'string' && typeof item.at === 'number').slice(0, INBOX_LOCAL_KEPT_MAX);
  } catch {
    list = NONE;
  }
  cache = { raw, list };
  return list;
}

/** Keep `key` (opened now): first in the list, once, the oldest past the cap dropped. */
export function keepLocal(key: string, now: number = Date.now()): void {
  const next = [{ key, at: now }, ...readKeptLocal().filter((item) => item.key !== key)].slice(0, INBOX_LOCAL_KEPT_MAX);
  try {
    storage()?.setItem(LOCAL_KEPT_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage: the row is still open now, only not kept.
  }
  for (const listener of listeners) listener();
}

/** The kept list, drawn again when something is kept. */
export function useKeptLocal(): readonly KeptLocal[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    readKeptLocal,
    () => NONE,
  );
}

const DAY_MS = 86_400_000;

/**
 * Whether a kept row shows in the group: open, it always does; else while it has work of its own beyond the default
 * branch (a count git could not give counts as work), and its last commit or change, or its opening, is within the
 * group's 14 days.
 */
export function keptShows(row: InboxLocalWork, openedAt: number, now: number, open: boolean): boolean {
  if (open) return true;
  if (inboxLocalSameAsBase(row)) return false;
  return Math.max(Date.parse(row.at) || 0, openedAt) >= now - INBOX_UNREPORTED_BRANCH_DAYS * DAY_MS;
}
