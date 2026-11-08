/**
 * The artifacts the person pinned (approval "inbox-artifact-stars"; the word
 * is Pin), as this window knows them: read from the server once something
 * draws a pin, read again on `event: artifact-pins` (another window or phone
 * pinned or unpinned) and after each of this window's own changes. Kept on the
 * server, so the person's phone and computer show the same pins. Not the
 * sidebar's thread pins (pins.ts).
 *
 * A press shows at once; the server's answer then replaces it, and a refusal
 * puts back what was there.
 */

import { useSyncExternalStore } from 'react';
import type { InboxArtifactPin } from '@plannotator/core/inbox-artifact-pins';
import { inboxApi } from './api';
import { machineOf } from './inboxUrl';

interface Snapshot {
  /** Null until the first read lands. */
  pins: readonly InboxArtifactPin[] | null;
  byKey: ReadonlyMap<string, InboxArtifactPin>;
}

let snapshot: Snapshot = { pins: null, byKey: new Map() };
const listeners = new Set<() => void>();
let reading: Promise<void> | null = null;
/** Bumped by every change this window makes: a read that started before it does not overwrite it. */
let changes = 0;

function publish(pins: readonly InboxArtifactPin[]): void {
  snapshot = { pins, byKey: new Map(pins.map((pin) => [pin.key, pin])) };
  for (const listener of listeners) listener();
}

/** Read the pins from the server (the first draw, and `event: artifact-pins`). A failed read keeps what is shown. */
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

/** The pins, live. Null while the first read is out. */
export function useArtifactPins(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Whether an artifact of a thread can be pinned here: a thread of this machine (a linked machine's thread keeps its own). */
export function artifactPinnable(threadId: string): boolean {
  return machineOf(threadId) === null;
}

/** One thread's pinned keys, the newest pin first: the order of the grid's Pinned group. */
export function threadPinnedKeys(pins: readonly InboxArtifactPin[] | null, threadId: string): string[] {
  if (!pins) return [];
  return pins
    .filter((pin) => pin.thread_id === threadId)
    .reverse()
    .map((pin) => pin.key);
}

/** Pin or unpin: shown at once, then the server's answer. Answers whether the server took it. */
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

/** Tests: forget what was read. */
export function resetArtifactPinsForTest(pins: readonly InboxArtifactPin[] | null = null): void {
  changes = 0;
  reading = null;
  if (pins) publish(pins);
  else snapshot = { pins: null, byKey: new Map() };
}
