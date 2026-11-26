/**
 * Reads a linked machine's door serves this window for that machine's own threads (mark `linked-reads`,
 * `INBOX_LINKED_MARKS` in core): a thread's steps, a guided review's whole files, image sides, package changes and
 * Viewed ticks, a referenced file's hover text, and a search with a Tag filter. An older Inbox there does not say the
 * mark, so the window asks it nothing new and shows what it showed before (docs/agent-guides/inbox-machines.md).
 */
import { useSyncExternalStore } from 'react';
import { INBOX_LINKED_READS_MARK } from '@plannotator/core/inbox-types';
import { linkedMachineFacts, linkedMachinesRev, machineOf, onLinkedMachines, selfMachineId } from './inboxUrl';

/**
 * A count that moves when the linked machines' facts change, marks included: what asks `readsServedFor` while it
 * draws takes it as a dependency, so a far thread opened before the merged list was read gets its reads once it is.
 */
export function useLinkedReadsRev(): number {
  return useSyncExternalStore(onLinkedMachines, linkedMachinesRev, () => 0);
}

/**
 * Whether a machine serves these reads. This machine always, by its own routes: an id with no machine (`null`: this
 * Inbox's own, or a window with no machines) or this machine's own id. A linked machine once its list says the mark;
 * one not listed yet, or older, does not.
 */
export function machineServesReads(machine: string | null | undefined): boolean {
  if (!machine) return true;
  if (machine === selfMachineId()) return true;
  return linkedMachineFacts(machine)?.marks.includes(INBOX_LINKED_READS_MARK) ?? false;
}

/** Whether the machine that owns this id (a thread, a message) serves these reads. */
export function readsServedFor(id: string | null | undefined): boolean {
  return machineServesReads(machineOf(id));
}

/**
 * The most reads of linked machines' threads out at once. A browser keeps a few connections to this window's own
 * origin; a sleeping machine's reads must never hold them all, so the list and this computer's threads stay quick.
 */
export const FAR_READS_AT_ONCE = 4;
let farReading = 0;
const farWaiting: (() => void)[] = [];

/** `run` (a read of `id`'s machine), queued past `FAR_READS_AT_ONCE` when that machine is a linked one. */
export async function farRead<T>(id: string | null | undefined, run: () => Promise<T>): Promise<T> {
  if (!onLinkedMachine(id)) return run();
  if (farReading >= FAR_READS_AT_ONCE) await new Promise<void>((go) => farWaiting.push(go));
  farReading += 1;
  try {
    return await run();
  } finally {
    farReading -= 1;
    farWaiting.shift()?.();
  }
}

/** Whether this id (a thread, a message) is on a linked machine rather than this one. */
export function onLinkedMachine(id: string | null | undefined): boolean {
  const machine = machineOf(id);
  return !!machine && machine !== selfMachineId();
}

/**
 * Whether a switch's feature is on for a thread or message: the machine that owns it decides. This machine's own
 * switch for its own; a linked machine's follows that machine's switch (`far`, as it said it), never this one's.
 */
export function ownerSwitch(id: string | null | undefined, here: boolean, far: boolean): boolean {
  return onLinkedMachine(id) ? far : here;
}

/**
 * Whether a thread's steps are read (null: none, this Inbox has no Steps switch). This computer's Steps switch for
 * its own threads; a linked machine's thread is always asked, and its answer's `on` (that machine's switch) decides.
 */
export function threadStepsRead(threadId: string, here: { on: boolean } | null | undefined): boolean | null {
  if (onLinkedMachine(threadId)) return true;
  return here ? here.on : null;
}
