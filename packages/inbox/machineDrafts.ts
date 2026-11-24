/**
 * Whether a thread's reply draft is kept (approval "inbox-reply-drafts"): always for this Inbox's own threads, and for a
 * linked machine's thread once that machine's list says it keeps reply drafts there (mark `reply-drafts`). Then the box
 * saves through the forward exactly as it saves here, and the draft is the same one on every window of both machines
 * (docs/agent-guides/inbox-machines.md, "Reply drafts"). An older Plannotator there keeps none: the words stay in the
 * box only, and dictated words for a closed box wait in this page, as before.
 */
import { linkedMachineFacts, machineOf } from './inboxUrl';

/** The mark a linked machine's list carries when it keeps reply drafts from here. */
export const REPLY_DRAFTS_MARK = 'reply-drafts';

export function keepsReplyDraft(threadId: string | null | undefined): boolean {
  const machine = machineOf(threadId);
  if (!machine) return true;
  return linkedMachineFacts(machine)?.marks.includes(REPLY_DRAFTS_MARK) === true;
}
