/**
 * The artifacts the person pinned (approval "inbox-artifact-stars"; the word
 * is Pin), as this window knows them: read from the server once something
 * draws a pin, read again on `event: artifact-pins` (another window or phone
 * pinned or unpinned) and after each of this window's own changes. Kept on the
 * server, so the person's phone and computer show the same pins. A linked
 * machine's thread keeps its pins on that machine: the read asks this Inbox
 * for every machine's (`?machines=1`, each far pin with `machine`), and a
 * press goes to the thread's machine. Not the sidebar's thread pins (pins.ts).
 *
 * A press shows at once; the server's answer then replaces it, and a refusal
 * puts back what was there.
 */

import { useSyncExternalStore } from 'react';
import type { InboxArtifactPin } from '@plannotator/core/inbox-artifact-pins';
import { InboxHeldError, inboxApi } from './api';
import { linkedMachineFacts, machineOf, selfMachineId } from './inboxUrl';

/** The mark a linked machine's list carries when it keeps its threads' artifact pins (`INBOX_LINKED_MARKS`). */
const ARTIFACT_PINS_MARK = 'artifact-pins';

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

/**
 * The pins an answer carries, picked by shape; null for an answer that is not a list of pins (an older Inbox's or a
 * proxy's body, `{}`). An entry that does not read as a pin is passed over.
 */
function pinsOf(answer: unknown): InboxArtifactPin[] | null {
  const pins = answer && typeof answer === 'object' ? (answer as { pins?: unknown }).pins : undefined;
  if (!Array.isArray(pins)) return null;
  return pins.filter((pin): pin is InboxArtifactPin => {
    const p = pin as Partial<InboxArtifactPin> | null;
    return !!p && typeof p === 'object' && typeof p.key === 'string' && typeof p.thread_id === 'string' && typeof p.pinned_at === 'string' && (p.machine === undefined || typeof p.machine === 'string');
  });
}

/**
 * Read the pins from the server (the first draw, and `event: artifact-pins`). A read that fails or answers something
 * else keeps what is shown (none known yet: no pins), and never throws: a file opens whatever the pins read does.
 */
export function readArtifactPins(): Promise<void> {
  const at = changes;
  const keep = () => {
    if (snapshot.pins === null && at === changes) publish([]);
  };
  const read = inboxApi.artifactPins().then(
    (answer) => {
      const pins = pinsOf(answer);
      if (pins === null) keep();
      else if (at === changes) publish(pins);
    },
    keep,
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

/**
 * Whether an artifact of a thread can be pinned here: a thread of this machine, or of a linked machine whose list
 * says it keeps artifact pins (mark `artifact-pins`; the pin lives on the thread's machine). An older Inbox there
 * offers no pin on its threads until it updates.
 */
export function artifactPinnable(threadId: string): boolean {
  const machine = machineOf(threadId);
  if (machine === null || machine === selfMachineId()) return true;
  return linkedMachineFacts(machine)?.marks.includes(ARTIFACT_PINS_MARK) ?? false;
}

/** A pin's machine: null for this Inbox's own. */
const pinMachine = (pin: InboxArtifactPin): string | null => pin.machine ?? null;

/** The pins with one machine's replaced by what that machine answered (a write's answer names its own pins only). */
function withMachinePins(machine: string | null, pins: readonly InboxArtifactPin[]): InboxArtifactPin[] {
  const others = (snapshot.pins ?? []).filter((pin) => pinMachine(pin) !== machine);
  const theirs = machine ? pins.map((pin) => ({ ...pin, machine })) : pins;
  return machine ? [...others, ...theirs] : [...theirs, ...others];
}

/** What says that a pin waits for its machine (App's toast, as a held star's); null before App set it. */
let sayHeld: ((cause: InboxHeldError) => void) | null = null;
/** App: how a held pin is told (the clock toast). Answers the cleanup for an effect. */
export function sayArtifactPinHeld(say: (cause: InboxHeldError) => void): () => void {
  sayHeld = say;
  return () => {
    if (sayHeld === say) sayHeld = null;
  };
}

/** One thread's pinned keys, the newest pin first: the order of the grid's Pinned group. */
export function threadPinnedKeys(pins: readonly InboxArtifactPin[] | null, threadId: string): string[] {
  if (!pins) return [];
  return pins
    .filter((pin) => pin.thread_id === threadId)
    .reverse()
    .map((pin) => pin.key);
}

/**
 * Pin or unpin: shown at once, then the server's answer. Answers whether the server took it. A linked machine's
 * thread's pin goes to that machine (through the forward and the outbox); while that machine is away it is held and
 * applies when it is back: the clock toast says so, and the pin shows once that machine has it (as a held star).
 */
export async function setArtifactPinned(threadId: string, key: string, pinned: boolean): Promise<boolean> {
  const before = snapshot.pins ?? [];
  const machine = machineOf(threadId);
  const home = machine && machine !== selfMachineId() ? machine : null;
  changes += 1;
  const at = changes;
  const pin: InboxArtifactPin = { key, thread_id: threadId, pinned_at: new Date().toISOString(), ...(home ? { machine: home } : {}) };
  publish(pinned ? [...before.filter((p) => p.key !== key), pin] : before.filter((p) => p.key !== key));
  try {
    const answer = await inboxApi.setArtifactPinned(threadId, key, pinned);
    // An answer that is not a list of pins: the press was taken, so what it shows stays.
    const pins = pinsOf(answer);
    if (pins !== null && at === changes) publish(withMachinePins(home, pins));
    return true;
  } catch (cause) {
    if (at === changes) publish(before);
    if (cause instanceof InboxHeldError) {
      sayHeld?.(cause);
      return true;
    }
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
