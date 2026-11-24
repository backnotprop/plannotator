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
