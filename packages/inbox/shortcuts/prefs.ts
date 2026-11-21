/**
 * The two keyboard settings (approval "inbox-keyboard-shortcuts"), Settings →
 * General → Keyboard, both on by default:
 *
 * - Single-key shortcuts: the keys that are one character (E, Z, R, F, O, J,
 *   K, N, `[`, `]`, `?`). Off, none of them does anything and none is hinted;
 *   ⌘ / Ctrl chords, Escape and the arrows keep working. WCAG 2.1.4 asks for
 *   this switch (speech input, a screen reader's quick keys).
 * - Show keys on buttons: the keycaps on buttons and in tooltips. Off, none is
 *   drawn; `aria-keyshortcuts` stays, so a screen reader still names the key.
 *
 * Window-only choices, kept in a cookie like the text size and the file view
 * (cookies ignore the port, so the choice holds when the Inbox comes back on
 * another one). Only "off" is written: a cookie that is gone reads as on.
 */
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
    // No cookies: the choice holds on this page only.
  }
}

function set(next: ShortcutPrefs): void {
  current = next;
  for (const listener of listeners) listener();
}

/** The settings now (for key handlers, which read them at the moment of the key). */
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

/** Read the cookies again (tests, and another tab's change on the next load). */
export function reloadShortcutPrefs(): void {
  set({ singleKeys: readOn(SINGLE_KEYS_COOKIE), hints: readOn(KEY_HINTS_COOKIE) });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The settings, and again whenever either changes (every hint redraws at once). */
export function useShortcutPrefs(): ShortcutPrefs {
  return useSyncExternalStore(subscribe, shortcutPrefs, shortcutPrefs);
}
