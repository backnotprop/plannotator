/**
 * Reads a linked machine's door serves this window for that machine's own threads (mark `linked-reads`,
 * `INBOX_LINKED_MARKS` in core): a thread's steps, a guided review's whole files, image sides, package changes and
 * Viewed ticks, a referenced file's hover text, and a search with a Tag filter. An older Inbox there does not say the
 * mark, so the window asks it nothing new and shows what it showed before (docs/agent-guides/inbox-machines.md).
 */
import { linkedMachineFacts, machineOf, selfMachineId } from './inboxUrl';

export const LINKED_READS_MARK = 'linked-reads';

/** Whether a machine serves these reads: this machine always; a linked one once its list says the mark. */
export function machineServesReads(machine: string | null | undefined): boolean {
  if (!machine || machine === selfMachineId()) return true;
  return linkedMachineFacts(machine)?.marks.includes(LINKED_READS_MARK) ?? false;
}

/** Whether the machine that owns this id (a thread, a message) serves these reads. */
export function readsServedFor(id: string | null | undefined): boolean {
  return machineServesReads(machineOf(id));
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
