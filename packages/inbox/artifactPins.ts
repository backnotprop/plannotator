import { useSyncExternalStore } from 'react';
import type { InboxArtifactPin } from '@plannotator/core/inbox-artifact-pins';
import { inboxApi } from './api';
import { machineOf } from './inboxUrl';

interface Snapshot {
  pins: readonly InboxArtifactPin[] | null;
  byKey: ReadonlyMap<string, InboxArtifactPin>;
}

let snapshot: Snapshot = { pins: null, byKey: new Map() };
const listeners = new Set<() => void>();
let reading: Promise<void> | null = null;
let changes = 0;

function publish(pins: readonly InboxArtifactPin[]): void {
  snapshot = { pins, byKey: new Map(pins.map((pin) => [pin.key, pin])) };
  for (const listener of listeners) listener();
}

export function readArtifactPins(): Promise<void> {
  const at = changes;
  const read = inboxApi.artifactPins().then(
    (answer) => {
      if (at === changes) publish(answer.pins);
    },
    () => {
      if (snapshot.pins === null && at === changes) publish([]);
    },
  );
  reading = read.finally(() => {
    if (reading === read) reading = null;
  });
  return read;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (snapshot.pins === null && !reading) void readArtifactPins();
  return () => listeners.delete(listener);
}

export function useArtifactPins(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function artifactPinnable(threadId: string): boolean {
  return machineOf(threadId) === null;
}

export function threadPinnedKeys(pins: readonly InboxArtifactPin[] | null, threadId: string): string[] {
  if (!pins) return [];
  return pins
    .filter((pin) => pin.thread_id === threadId)
    .reverse()
    .map((pin) => pin.key);
}

export async function setArtifactPinned(threadId: string, key: string, pinned: boolean): Promise<boolean> {
  const before = snapshot.pins ?? [];
  changes += 1;
  const at = changes;
  publish(pinned ? [...before.filter((pin) => pin.key !== key), { key, thread_id: threadId, pinned_at: new Date().toISOString() }] : before.filter((pin) => pin.key !== key));
  try {
    const answer = await inboxApi.setArtifactPinned(threadId, key, pinned);
    if (at === changes) publish(answer.pins);
    return true;
  } catch {
    if (at === changes) publish(before);
    return false;
  }
}

export function resetArtifactPinsForTest(pins: readonly InboxArtifactPin[] | null = null): void {
  changes = 0;
  reading = null;
  if (pins) publish(pins);
  else snapshot = { pins: null, byKey: new Map() };
}
