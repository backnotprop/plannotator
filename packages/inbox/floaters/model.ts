import { useSyncExternalStore } from 'react';
import type { InboxReplyDraft, InboxReplyDraftRow } from '@plannotator/core/inbox-types';

const SET_KEY = 'plannotator-reply-floaters';

export const FLOAT_MIN_CHARS = 8;
export const FLOAT_MAX_AGE_MS = 24 * 60 * 60_000;
export const FLOAT_SETTLE_MS = 4_000;

export function floatWorthy(body: string, files: number): boolean {
  return files > 0 || body.trim().length >= FLOAT_MIN_CHARS;
}

/** `entered`: the draft's `updated_at` when the thread opened (null: none then; undefined: not read yet, counted as typed). */
export function floatsAfterVisit(entered: string | null | undefined, now: Pick<InboxReplyDraft, 'body' | 'updated_at' | 'files'> | null): boolean {
  if (!now) return false;
  if (entered !== undefined && now.updated_at === entered) return false;
  return floatWorthy(now.body, now.files?.length ?? 0);
}

export interface FloatEntry {
  id: string;
  at: number;
}

const hasWords = (row: InboxReplyDraftRow) => !!row.unsent?.reply_at;

export function floatingDrafts(entries: readonly FloatEntry[], rows: readonly InboxReplyDraftRow[], openThread: string | null): InboxReplyDraftRow[] {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  return entries.flatMap((entry) => {
    const row = byId.get(entry.id);
    return row && hasWords(row) && entry.id !== openThread ? [row] : [];
  });
}

export function staleFloats(entries: readonly FloatEntry[], rows: readonly InboxReplyDraftRow[], openWindows: readonly string[], now: number): string[] {
  const byId = new Map(rows.map((row) => [row.thread_id, row]));
  return entries.flatMap((entry) => {
    const row = byId.get(entry.id);
    const edited = row?.unsent?.reply_at ? Date.parse(row.unsent.reply_at) : NaN;
    const touched = Number.isFinite(edited) ? Math.max(entry.at, edited) : entry.at;
    if (now - touched > FLOAT_MAX_AGE_MS) return [entry.id];
    if (now - entry.at < FLOAT_SETTLE_MS || openWindows.includes(entry.id)) return [];
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
  }
  for (const listener of listeners) listener();
}

export function floatThread(id: string, at = Date.now()): void {
  write([{ id, at }, ...entries.filter((entry) => entry.id !== id)]);
}

export function unfloatThread(id: string): void {
  if (entries.some((entry) => entry.id === id)) write(entries.filter((entry) => entry.id !== id));
}

export function floatEntries(): readonly FloatEntry[] {
  return entries;
}

export function rereadFloatEntries(): void {
  entries = readEntries();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
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

export function floaterName(row: { thread_name?: string | null; subject?: string | null }): string {
  return row.thread_name || row.subject || 'Thread';
}
