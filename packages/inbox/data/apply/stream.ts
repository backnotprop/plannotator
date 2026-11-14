import type { QueryClient } from '@tanstack/react-query';
import type { InboxEvent } from '../../api';
import { threadOfRecord } from '../../openThreadReads';
import { threadDrawReady } from '../../threadDrawReady';
import { changeThread, heldThread, isThreadStale, noteMissed, staleThread, staleThreads } from '../queries/thread';
import { drawSoon } from './drawGap';
import { machineOf } from '../../inboxUrl';
import { applyRecord, recordMovesFiles, type HeldThread } from './record';

export type StreamOutcome = { threadId: string; kind: 'applied' | 'none' | 'reread' | 'unheld'; files?: boolean } | { threadId: null; kind: 'any' };

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
    if (!machineOf(threadId) && 'seq' in event && typeof event.seq === 'number') noteMissed(threadId, event.seq);
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
