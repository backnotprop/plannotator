/**
 * The last few threads the person opened, as their last read brought them, so going back to one draws it at once
 * while its read goes out again in the background (data-layer brief, 2026-11-10: every open read the whole thread,
 * 2.7 s for a long one on a poor link).
 *
 * Never stale shown as current. A copy is kept only while nothing could have changed it:
 *  - any event-stream record of that thread drops it (a message, a question, a comment), and a record the window
 *    cannot place, or a project record, drops every copy;
 *  - a gap in the stream (it went quiet, reconnected, or caught up) drops every copy;
 *  - the window's own pick saves drop the open thread's copy (the pane drew them, the copy did not);
 *  - a copy older than THREAD_CACHE_MAX_AGE_MS is not shown (the server refreshes a repo's links on a read);
 *  - only this Inbox's own threads that the list shows, and never a launched thread (its run line moves without a
 *    record), are kept: a row shown from the read itself (an archived thread) or another machine's thread is not.
 * Bounded: THREAD_CACHE_SIZE threads, the least recently opened dropped first.
 */
import type { ThreadModel } from './api';

export const THREAD_CACHE_SIZE = 8;
export const THREAD_CACHE_MAX_AGE_MS = 5 * 60_000;

export interface ThreadCache {
  /** The thread's last read, when kept and fresh enough to show; marks it the most recent. */
  get(threadId: string, now?: number): ThreadModel | null;
  /** A read of the thread starts: its answer is kept only if nothing dropped the thread meanwhile (`put` with this). */
  begin(threadId: string): number;
  /** Keep a read's answer; a read that `begin` numbered before a drop (it may predate the record) is not kept. */
  put(threadId: string, model: ThreadModel, token: number, now?: number): void;
  drop(threadId: string): void;
  clear(): void;
  /** Keep only the threads `keep` says (the list's rows). */
  prune(keep: (threadId: string) => boolean): void;
  size(): number;
}

export function createThreadCache(size: number = THREAD_CACHE_SIZE, maxAgeMs: number = THREAD_CACHE_MAX_AGE_MS): ThreadCache {
  const kept = new Map<string, { model: ThreadModel; at: number }>();
  /** Bumped by every drop: a read begun before it is not kept. */
  let generation = 0;
  const dropped = new Map<string, number>();
  let clearedAt = 0;
  return {
    get(threadId, now = Date.now()) {
      const entry = kept.get(threadId);
      if (!entry) return null;
      if (now - entry.at > maxAgeMs) {
        kept.delete(threadId);
        return null;
      }
      kept.delete(threadId);
      kept.set(threadId, entry);
      return entry.model;
    },
    begin: () => generation,
    put(threadId, model, token, now = Date.now()) {
      if (token < clearedAt || token < (dropped.get(threadId) ?? 0)) return;
      kept.delete(threadId);
      kept.set(threadId, { model, at: now });
      while (kept.size > size) kept.delete(kept.keys().next().value!);
    },
    drop(threadId) {
      kept.delete(threadId);
      generation += 1;
      dropped.set(threadId, generation);
      // Bounded: the oldest marks go once there are many (a read that old has long answered).
      if (dropped.size > 256) dropped.delete(dropped.keys().next().value!);
    },
    clear() {
      kept.clear();
      generation += 1;
      clearedAt = generation;
      dropped.clear();
    },
    prune(keep) {
      for (const threadId of [...kept.keys()]) if (!keep(threadId)) kept.delete(threadId);
    },
    size: () => kept.size,
  };
}
