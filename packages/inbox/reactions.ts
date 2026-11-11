import { useSyncExternalStore } from 'react';
import { INBOX_SAVED_REACTIONS_MAX, applyInboxReactionChange, parseInboxSavedReactions, type InboxReaction, type InboxReactionChange } from '@plannotator/core/inbox-types';
import { storage } from '@plannotator/ui/utils/storage';
import { inboxApi } from './api';

const EMPTY: InboxReaction[] = [];
let current: InboxReaction[] = EMPTY;
let server: InboxReaction[] = EMPTY;
let serverRev = -1;
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
      pending.shift();
      recompute();
      failed?.(cause);
    }
  }
  sending = false;
}

function change(next: InboxReactionChange): void {
  if (same(withPending(current, [next]), current)) return;
  pending.push(next);
  recompute();
  if (!sending) void send();
}

export function savedReactions(): InboxReaction[] {
  return current;
}

export function reactionsReadMark(): number {
  return serverRev;
}

export function adoptSavedReactions(value: unknown, rev?: unknown, sentAt?: number): void {
  const list = parseInboxSavedReactions(value);
  if (!list) return;
  if (typeof rev === 'number' && sentAt !== undefined && rev < sentAt) serverRev = -1;
  hear(list, rev);
}

export function hearReactionsEvent(value: unknown, rev?: unknown): void {
  const list = parseInboxSavedReactions(value);
  if (list) hear(list, rev);
}

export function onSavedReactionsFailed(handler: ((cause: unknown) => void) | null): void {
  failed = handler;
}

export function addSavedReaction(emoji: string): number {
  const at = current.findIndex((r) => r.emoji === emoji);
  if (at >= 0) return at;
  if (current.length >= INBOX_SAVED_REACTIONS_MAX) return -1;
  change({ op: 'add', emoji });
  return current.findIndex((r) => r.emoji === emoji);
}

export function nameSavedReaction(index: number, label: string): void {
  const was = current[index];
  if (was) change({ op: 'name', emoji: was.emoji, label });
}

export function changeSavedReaction(index: number, emoji: string): void {
  const was = current[index];
  if (was) change({ op: 'change', emoji: was.emoji, to: emoji });
}

export function removeSavedReaction(index: number): void {
  const was = current[index];
  if (was) change({ op: 'remove', emoji: was.emoji });
}

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
  }
}

export function resetSavedReactionsForTests(list: InboxReaction[] = EMPTY): void {
  pending = [];
  sending = false;
  serverRev = -1;
  server = list;
  failed = null;
  recompute();
  current = list;
}
