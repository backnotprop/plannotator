/**
 * The reaction tray's saved emoji (approval "inbox-reaction-tray"): the
 * person's own emoji beside 👍 in the tray, each with an optional name, up
 * to INBOX_SAVED_REACTIONS_MAX, in the order saved.
 *
 * Kept in config.json `inboxReactions`. A change shows at once and is sent as
 * one change (POST /api/inbox/settings `reaction_change`: add, name, change
 * or remove an emoji), which the server applies to the list as it is then, so
 * a laptop and a phone never write over each other's emoji. One change is on
 * its way at a time, in the order made. Every window hears each save
 * (`event: reactions`) and takes every settings read; `reactions_rev` counts
 * the saves, so a late answer never puts an older list back. The list shown is
 * the server's newest with this page's unanswered changes on top. A change the
 * server refused is taken back, and the window says why (`onSavedReactionsFailed`).
 */

import { useSyncExternalStore } from 'react';
import { INBOX_SAVED_REACTIONS_MAX, applyInboxReactionChange, parseInboxSavedReactions, type InboxReaction, type InboxReactionChange } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

const EMPTY: InboxReaction[] = [];
/** The list on screen: `server` with `pending` on top. */
let current: InboxReaction[] = EMPTY;
/** The newest list the server told this page of, and its save count. */
let server: InboxReaction[] = EMPTY;
let serverRev = -1;
/** This page's changes not yet answered, in the order made; the first is on its way. */
let pending: InboxReactionChange[] = [];
let sending = false;
let failed: ((cause: unknown) => void) | null = null;
const listeners = new Set<() => void>();

const same = (a: readonly InboxReaction[], b: readonly InboxReaction[]) => JSON.stringify(a) === JSON.stringify(b);
const withPending = (list: InboxReaction[], changes: readonly InboxReactionChange[]) => changes.reduce((acc, c) => applyInboxReactionChange(acc, c) ?? acc, list);

function recompute(): void {
  const list = withPending(server, pending);
  if (same(list, current)) return;
  current = list;
  for (const listener of listeners) listener();
}

/** The server's list, if not older than the last this page heard. */
function hear(list: InboxReaction[], rev: unknown): void {
  const count = typeof rev === 'number' && Number.isFinite(rev) ? rev : Math.max(serverRev, 0);
  if (count < serverRev) return;
  serverRev = count;
  server = list;
  recompute();
}

async function send(): Promise<void> {
  sending = true;
  while (pending.length) {
    const next = pending[0]!;
    const before = serverRev;
    try {
      const answer = await inboxApi.changeReaction(next);
      pending.shift();
      const list = parseInboxSavedReactions(answer.reactions);
      // A count below the one this page had heard: config.json was reset or restored; count again from this answer.
      if (typeof answer.reactions_rev === 'number' && answer.reactions_rev < before) serverRev = -1;
      if (list) hear(list, answer.reactions_rev);
      else recompute();
    } catch (cause) {
      // Refused (the tray filled up in another window, offline, config.json not saved): the change is taken back.
      pending.shift();
      recompute();
      failed?.(cause);
    }
  }
  sending = false;
}

/** The person's change: shown at once, then sent after the ones before it. One that changes nothing is not sent. */
function change(next: InboxReactionChange): void {
  if (same(withPending(current, [next]), current)) return;
  pending.push(next);
  recompute();
  if (!sending) void send();
}

/** The saved list as of now. */
export function savedReactions(): InboxReaction[] {
  return current;
}

/** Taken when a settings read is sent, and given back with its answer (`adoptSavedReactions`'s `sentAt`). */
export function reactionsReadMark(): number {
  return serverRev;
}

/**
 * A settings read's list (GET /api/inbox/settings `reactions`, `reactions_rev`). An older Inbox's absent field
 * changes nothing. A count below the one this page had heard when the read was sent (`sentAt`) means config.json
 * was reset or restored: the read is taken, and counting starts again from it.
 */
export function adoptSavedReactions(value: unknown, rev?: unknown, sentAt?: number): void {
  const list = parseInboxSavedReactions(value);
  if (!list) return;
  if (typeof rev === 'number' && sentAt !== undefined && rev < sentAt) serverRev = -1;
  hear(list, rev);
}

/** A save, here or in another window (`event: reactions`). */
export function hearReactionsEvent(value: unknown, rev?: unknown): void {
  const list = parseInboxSavedReactions(value);
  if (list) hear(list, rev);
}

/** What the window does when the server refuses a change (the change is already taken back). */
export function onSavedReactionsFailed(handler: ((cause: unknown) => void) | null): void {
  failed = handler;
}

/** Saves `emoji` at the end of the tray (once; never past the cap). Returns the index it has, or -1 when the tray is full. */
export function addSavedReaction(emoji: string): number {
  const at = current.findIndex((r) => r.emoji === emoji);
  if (at >= 0) return at;
  if (current.length >= INBOX_SAVED_REACTIONS_MAX) return -1;
  change({ op: 'add', emoji });
  return current.findIndex((r) => r.emoji === emoji);
}

/** Names saved emoji `index` ('' takes the name away). */
export function nameSavedReaction(index: number, label: string): void {
  const was = current[index];
  if (was) change({ op: 'name', emoji: was.emoji, label });
}

/** Puts another emoji in saved spot `index`, keeping its name (an emoji saved elsewhere already moves here). */
export function changeSavedReaction(index: number, emoji: string): void {
  const was = current[index];
  if (was) change({ op: 'change', emoji: was.emoji, to: emoji });
}

/** Takes saved emoji `index` out of the tray; the ones after it move up. */
export function removeSavedReaction(index: number): void {
  const was = current[index];
  if (was) change({ op: 'remove', emoji: was.emoji });
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

/** Tests only: a fresh page with `list` saved, nothing heard and no change on its way. */
export function resetSavedReactionsForTests(list: InboxReaction[] = EMPTY): void {
  pending = [];
  sending = false;
  serverRev = -1;
  server = list;
  failed = null;
  recompute();
  current = list;
}
