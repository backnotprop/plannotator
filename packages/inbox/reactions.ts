/**
 * The reaction tray's saved emoji (approval "inbox-reaction-tray"): the
 * person's own emoji beside 👍 in the tray, each with an optional name, up
 * to INBOX_SAVED_REACTIONS_MAX, in the order saved.
 *
 * Kept in config.json `inboxReactions` through POST /api/inbox/settings
 * `{ reactions }` (the whole list), the way the text size is: a change shows
 * at once and is then saved; every settings read adopts the saved list,
 * except while one of this page's own saves is on its way (it would put the
 * old list back for a moment).
 */

import { useSyncExternalStore } from 'react';
import { INBOX_SAVED_REACTIONS_MAX, parseInboxSavedReactions, type InboxReaction } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

const EMPTY: InboxReaction[] = [];
let current: InboxReaction[] = EMPTY;
let saving = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function apply(list: InboxReaction[]): void {
  current = list;
  emit();
}

/** The saved list as of now. */
export function savedReactions(): InboxReaction[] {
  return current;
}

/** A settings read's list (GET /api/inbox/settings `reactions`); an older Inbox's absent field changes nothing. */
export function adoptSavedReactions(value: unknown): void {
  if (saving > 0) return;
  const list = parseInboxSavedReactions(value);
  if (!list) return;
  if (JSON.stringify(list) === JSON.stringify(current)) return;
  apply(list);
}

/** The person's change: shown at once, then saved to config.json. */
function save(list: InboxReaction[]): Promise<void> {
  apply(list);
  saving += 1;
  return inboxApi.saveReactions(list).then(
    () => {
      saving -= 1;
    },
    () => {
      saving -= 1;
    },
  );
}

/** Saves `emoji` at the end of the tray (once; never past the cap). Resolves the index it has, or -1 when the tray is full. */
export function addSavedReaction(emoji: string): number {
  const at = current.findIndex((r) => r.emoji === emoji);
  if (at >= 0) return at;
  if (current.length >= INBOX_SAVED_REACTIONS_MAX) return -1;
  void save([...current, { emoji }]);
  return current.length - 1;
}

/** Names saved emoji `index` ('' takes the name away). */
export function nameSavedReaction(index: number, label: string): void {
  const was = current[index];
  if (!was) return;
  const name = label.trim();
  if ((was.label ?? '') === name) return;
  const next = [...current];
  next[index] = name ? { emoji: was.emoji, label: name } : { emoji: was.emoji };
  void save(next);
}

/** Puts another emoji in saved spot `index`, keeping its name (an emoji saved elsewhere already moves here). */
export function changeSavedReaction(index: number, emoji: string): void {
  const was = current[index];
  if (!was || was.emoji === emoji) return;
  const next = current.filter((r, i) => i === index || r.emoji !== emoji);
  const at = next.indexOf(was);
  next[at] = was.label ? { emoji, label: was.label } : { emoji };
  void save(next);
}

/** Takes saved emoji `index` out of the tray; the ones after it move up. */
export function removeSavedReaction(index: number): void {
  if (!current[index]) return;
  void save(current.filter((_, i) => i !== index));
}

/** How many free + the tray shows: two while none is saved, then always one, none once the tray is full. */
export function freeSlots(saved: number): number {
  if (saved >= INBOX_SAVED_REACTIONS_MAX) return 0;
  return saved === 0 ? 2 : 1;
}

export function useSavedReactions(): InboxReaction[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => EMPTY,
  );
}

/* The picker's Recent row: the emoji this browser reacted with or saved last, newest first. A cookie, like the text size's. */
export const RECENT_EMOJI_COOKIE = 'plannotator-inbox-recent-emoji';
const RECENT_MAX = 16;

export function recentEmoji(): string[] {
  try {
    const value = JSON.parse(storage.getItem(RECENT_EMOJI_COOKIE) ?? '[]');
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    storage.setItem(RECENT_EMOJI_COOKIE, JSON.stringify([emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, RECENT_MAX)));
  } catch {
    // A page with no cookies still reacts; the emoji is only not in Recent next time.
  }
}

/** Tests only: a fresh page with nothing saved and no save on its way. */
export function resetSavedReactionsForTests(list: InboxReaction[] = EMPTY): void {
  saving = 0;
  apply(list);
}
