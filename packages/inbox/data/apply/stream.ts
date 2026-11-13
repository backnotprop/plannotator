/**
 * The live stream's records, into the cache: each one changes the thread it belongs to in place (`record.ts`), with
 * no read. What a record cannot carry marks its thread stale, and a record that may change any thread (a project's,
 * one the window cannot place) marks them all; a gap in the stream does too (App calls `staleThreads`).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { InboxEvent } from '../../api';
import { threadOfRecord } from '../../openThreadReads';
import { threadDrawReady } from '../../threadDrawReady';
import { changeThread, heldThread, isThreadStale, staleThread, staleThreads } from '../queries/thread';
import { drawSoon } from './drawGap';
import { applyRecord, recordMovesFiles, type HeldThread } from './record';

/**
 * What the record did to the cache: `applied` (its thread drawn anew from it), `none` (held, and nothing it shows
 * changed: a replay, a comment, which the thread's files carry), `reread` (only a read can show it: the thread is
 * stale now), `unheld` (not held, or held stale: the next read brings it whole), `any` (it may change any thread:
 * all are stale).
 */
export type StreamOutcome = { threadId: string; kind: 'applied' | 'none' | 'reread' | 'unheld'; files?: boolean } | { threadId: null; kind: 'any' };

/**
 * How often a record fell back to a read (by kind and why), since the window opened: `reread` (its thread: the
 * applier has no in-place case for what it says) and `any` (every held thread: a project's, or one not placed). A
 * fallback is correct, only slower; these show what the applier still does not take in place.
 */
const fallbacks = new Map<string, number>();
export function applierFallbacks(): Record<string, number> {
  return Object.fromEntries(fallbacks);
}
const fellBack = (event: InboxEvent | null, why: 'reread' | 'any') => {
  const key = `${event?.kind ?? 'unplaced'}:${why}`;
  fallbacks.set(key, (fallbacks.get(key) ?? 0) + 1);
};

const ahead = new Map<string, HeldThread>();
const gates = new Map<string, Promise<unknown>>();

export function applyStreamRecord(client: QueryClient, event: InboxEvent | null): StreamOutcome {
  const threadId = event ? threadOfRecord(event) : null;
  if (!event || threadId === null) {
    fellBack(event, 'any');
    ahead.clear();
    staleThreads(client);
    return { threadId: null, kind: 'any' };
  }
  const held = heldThread(client, threadId);
  if (!held || isThreadStale(client, threadId)) {
    ahead.delete(threadId);
    return { threadId, kind: 'unheld' };
  }
  const base = ahead.get(threadId) ?? held;
  const outcome = applyRecord(base, event);
  const files = recordMovesFiles(base, event);
  if (outcome.kind === 'reread') {
    fellBack(event, 'reread');
    ahead.delete(threadId);
    staleThread(client, threadId);
  }
  if (outcome.kind !== 'applied') return { threadId, kind: outcome.kind, files };
  const mine = outcome.model;
  ahead.set(threadId, mine);
  const ready = event.kind === 'message' ? threadDrawReady(mine.thread) : null;
  const write = () => {
    if (ahead.get(threadId) === mine) ahead.delete(threadId);
    const now = heldThread(client, threadId);
    if (!now || isThreadStale(client, threadId)) return;
    const again = applyRecord(now, event);
    if (again.kind === 'applied') changeThread(client, threadId, () => again.model);
    else if (again.kind === 'reread') staleThread(client, threadId);
  };
  const before = gates.get(threadId);
  const gate = before && ready ? Promise.allSettled([before, ready]) : (before ?? ready);
  if (!gate) {
    drawSoon(write);
    return { threadId, kind: 'applied', files };
  }
  const queued = gate.then(() => drawSoon(write), () => drawSoon(write));
  gates.set(threadId, queued);
  void queued.then(() => {
    if (gates.get(threadId) === queued) gates.delete(threadId);
  });
  return { threadId, kind: 'applied', files };
}
