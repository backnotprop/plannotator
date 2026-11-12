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
import { applyRecord } from './record';

/**
 * What the record did to the cache: `applied` (its thread drawn anew from it), `none` (held, and nothing it shows
 * changed: a replay, a comment, which the thread's files carry), `reread` (only a read can show it: the thread is
 * stale now), `unheld` (not held, or held stale: the next read brings it whole), `any` (it may change any thread:
 * all are stale).
 */
export type StreamOutcome = { threadId: string; kind: 'applied' | 'none' | 'reread' | 'unheld' } | { threadId: null; kind: 'any' };

export function applyStreamRecord(client: QueryClient, event: InboxEvent | null): StreamOutcome {
  const threadId = event ? threadOfRecord(event) : null;
  if (!event || threadId === null) {
    staleThreads(client);
    return { threadId: null, kind: 'any' };
  }
  const held = heldThread(client, threadId);
  // Not held, or held stale (it missed records): the next read brings it whole.
  if (!held || isThreadStale(client, threadId)) return { threadId, kind: 'unheld' };
  const outcome = applyRecord(held, event);
  if (outcome.kind === 'reread') staleThread(client, threadId);
  if (outcome.kind !== 'applied') return { threadId, kind: outcome.kind };
  // A message's code fences and math load their grammar first (#2593): it draws highlighted, never plain first.
  // Applied on what is held then: another record or a read may have landed meanwhile (`applied` keeps the order).
  const ready = event.kind === 'message' ? threadDrawReady(outcome.model.thread) : null;
  const write = () => {
    const now = heldThread(client, threadId);
    if (!now || isThreadStale(client, threadId)) return;
    const again = applyRecord(now, event);
    if (again.kind === 'applied') changeThread(client, threadId, () => again.model);
    else if (again.kind === 'reread') staleThread(client, threadId);
  };
  if (ready) void ready.then(() => drawSoon(write), () => drawSoon(write));
  else drawSoon(write);
  return { threadId, kind: 'applied' };
}
