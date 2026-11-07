/**
 * Floating reply drafts (approval "inbox-reply-floaters", 2026-11-07): a reply draft set aside floats in the
 * bottom right corner, beside this thread's Ask AI chat, like a mail app's draft windows.
 *
 * The words live in the thread's reply draft (`replyDraft.ts`, the server's `inbox/reply-drafts/`) and nowhere
 * else. This file keeps only which threads float and since when, in this browser's localStorage, and the rules
 * that decide it. Everything here is plain functions, so the rules are tested without a window.
 */
import { useSyncExternalStore } from 'react';
import type { InboxReplyDraft, InboxReplyDraftRow } from '@plannotator/core/inbox-types';

const SET_KEY = 'plannotator-reply-floaters';

/** A draft under this floats nowhere (a stray half word). It stays a draft: the row and the Drafts page still have it. */
export const FLOAT_MIN_CHARS = 8;
/** Untouched this long, a draft stops floating. It stays a draft. */
export const FLOAT_MAX_AGE_MS = 24 * 60 * 60_000;
/** A thread that just started to float is left alone this long, while the drafts list catches up with its save. */
export const FLOAT_SETTLE_MS = 4_000;

/** Enough to float: 8 characters of words, or a file. */
export function floatWorthy(body: string, files: number): boolean {
  return files > 0 || body.trim().length >= FLOAT_MIN_CHARS;
}

/**
 * Whether a draft floats once its box closed (T6's down arrow, Escape) or the person left its thread: only when
 * they typed in it on this visit, so its `updated_at` moved since the thread opened, and it holds enough.
 * `entered`: the draft's `updated_at` when the thread opened (null: none then; undefined: not read yet, which
 * counts as typed, since the person could not have seen the read).
 */
export function floatsAfterVisit(entered: string | null | undefined, now: Pick<InboxReplyDraft, 'body' | 'updated_at' | 'files'> | null): boolean {
  if (!now) return false;
  if (entered !== undefined && now.updated_at === entered) return false;
  return floatWorthy(now.body, now.files?.length ?? 0);
}

export interface FloatEntry {
  id: string;
  /** When it started to float (ms). Leaving its thread again after typing brings it to the front. */
  at: number;
}

/** The row holds reply words (picks and comments alone never float: they need the thread's own Send). */
const hasWords = (row: InboxReplyDraftRow) => !!row.unsent?.reply_at;

/**
 * The drafts the corner shows, newest first: floating, with words, and not the open thread's (its own box has it).
 */
export function floatingDrafts(entries: readonly FloatEntry[], rows: readonly InboxReplyDraftRow[], openThread: string | null): InboxReplyDraftRow[] {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  return entries.flatMap((entry) => {
    const row = byId.get(entry.id);
    return row && hasWords(row) && entry.id !== openThread ? [row] : [];
  });
}

/**
 * The threads that stop floating: sent or discarded anywhere (no row with words), or older than a day. One that
 * started a moment ago, or whose window is open, is kept until the drafts list has caught up.
 */
export function staleFloats(entries: readonly FloatEntry[], rows: readonly InboxReplyDraftRow[], openWindows: readonly string[], now: number): string[] {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  return entries.flatMap((entry) => {
    if (now - entry.at > FLOAT_MAX_AGE_MS) return [entry.id];
    if (now - entry.at < FLOAT_SETTLE_MS || openWindows.includes(entry.id)) return [];
    const row = byId.get(entry.id);
    return !row || !hasWords(row) ? [entry.id] : [];
  });
}

let entries: FloatEntry[] = readEntries();
const listeners = new Set<() => void>();

function readEntries(): FloatEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SET_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((e): e is FloatEntry => typeof e?.id === 'string' && typeof e?.at === 'number') : [];
  } catch {
    return [];
  }
}

function write(next: FloatEntry[]): void {
  entries = next;
  try {
    window.localStorage.setItem(SET_KEY, JSON.stringify(next));
  } catch {
    // A full or blocked storage: the corner still works for this page.
  }
  for (const listener of listeners) listener();
}

/** Newest first. */
export function floatThread(id: string, at = Date.now()): void {
  write([{ id, at }, ...entries.filter((entry) => entry.id !== id)]);
}

export function unfloatThread(id: string): void {
  if (entries.some((entry) => entry.id === id)) write(entries.filter((entry) => entry.id !== id));
}

export function floatEntries(): readonly FloatEntry[] {
  return entries;
}

/** Tests: start from what localStorage holds now. */
export function rereadFloatEntries(): void {
  entries = readEntries();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Two windows of this Inbox share the list: a draft put away in one goes in the other.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SET_KEY) return;
    entries = readEntries();
    for (const each of listeners) each();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function useFloatEntries(): readonly FloatEntry[] {
  return useSyncExternalStore(subscribe, () => entries, () => entries);
}

/**
 * The thread's own box closed and kept its draft (T6's down arrow, or Escape in the box). Thread.tsx calls this;
 * the corner reads the draft once its save landed and floats it when the person typed on this visit.
 */
const setAsideListeners = new Set<(threadId: string) => void>();
export function replyBoxSetAside(threadId: string): void {
  for (const listener of setAsideListeners) listener(threadId);
}
export function onReplyBoxSetAside(listener: (threadId: string) => void): () => void {
  setAsideListeners.add(listener);
  return () => {
    setAsideListeners.delete(listener);
  };
}

/** App's event stream says a reply draft (or a record) changed; open draft windows read again. */
const eventListeners = new Set<(kind: 'draft' | 'record', threadId: string | null) => void>();
export function emitFloaterEvent(kind: 'draft' | 'record', threadId: string | null): void {
  for (const listener of eventListeners) listener(kind, threadId);
}
export function onFloaterEvent(listener: (kind: 'draft' | 'record', threadId: string | null) => void): () => void {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}

/** A message's words for the draft window's one line peek: no question blocks, no markdown marks. */
export function peekText(body: string): string {
  return body
    .replace(/:::[\s\S]*?(:::|$)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** What a draft is called: the thread's name when it has one, else its subject. */
export function floaterName(row: { thread_name?: string | null; subject?: string | null }): string {
  return row.thread_name || row.subject || 'Thread';
}
