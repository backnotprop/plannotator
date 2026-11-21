/**
 * Dictated words that did not reach their thread's reply after the person moved on (voiceSession.ts `attach`): the take
 * failed, or its words could not be saved in the draft. Kept per thread for this page's life, so the thread says so
 * (with Retry where something can be retried) when the person is in it, or comes back to it.
 */
import { useCallback, useSyncExternalStore } from 'react';

export interface LateVoiceMiss {
  retry: (() => void) | null;
}

export const LATE_VOICE_MISSED = 'Dictation failed, so those words are not in the reply.';

const misses = new Map<string, LateVoiceMiss>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function noteLateVoiceMiss(threadId: string, retry: (() => void) | null): void {
  misses.set(threadId, { retry });
  for (const listener of listeners) listener();
}

export function clearLateVoiceMiss(threadId: string): void {
  if (misses.delete(threadId)) for (const listener of listeners) listener();
}

export const lateVoiceMissOf = (threadId: string): LateVoiceMiss | null => misses.get(threadId) ?? null;

export function useLateVoiceMiss(threadId: string): LateVoiceMiss | null {
  const read = useCallback(() => lateVoiceMissOf(threadId), [threadId]);
  return useSyncExternalStore(subscribe, read, read);
}
