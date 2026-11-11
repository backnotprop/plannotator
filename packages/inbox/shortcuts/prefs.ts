/** Only "off" is written to the cookie: a cookie that is gone reads as on. */
import { useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const SINGLE_KEYS_COOKIE = 'plannotator-inbox-single-keys';
export const KEY_HINTS_COOKIE = 'plannotator-inbox-key-hints';

export interface ShortcutPrefs {
  singleKeys: boolean;
  hints: boolean;
}

function readOn(cookie: string): boolean {
  try {
    return storage.getItem(cookie) !== 'off';
  } catch {
    return true;
  }
}

let current: ShortcutPrefs = { singleKeys: readOn(SINGLE_KEYS_COOKIE), hints: readOn(KEY_HINTS_COOKIE) };
const listeners = new Set<() => void>();

function write(cookie: string, on: boolean): void {
  try {
    if (on) storage.removeItem(cookie);
    else storage.setItem(cookie, 'off');
  } catch {
  }
}

function set(next: ShortcutPrefs): void {
  current = next;
  for (const listener of listeners) listener();
}

export function shortcutPrefs(): ShortcutPrefs {
  return current;
}

export function setSingleKeys(on: boolean): void {
  write(SINGLE_KEYS_COOKIE, on);
  set({ ...current, singleKeys: on });
}

export function setKeyHints(on: boolean): void {
  write(KEY_HINTS_COOKIE, on);
  set({ ...current, hints: on });
}

export function reloadShortcutPrefs(): void {
  set({ singleKeys: readOn(SINGLE_KEYS_COOKIE), hints: readOn(KEY_HINTS_COOKIE) });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShortcutPrefs(): ShortcutPrefs {
  return useSyncExternalStore(subscribe, shortcutPrefs, shortcutPrefs);
}
