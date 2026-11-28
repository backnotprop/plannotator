/**
 * Whether a thread's reply draft is kept (approval "inbox-reply-drafts"): always for this Inbox's own threads, and for a
 * linked machine's thread once that machine's list says it keeps reply drafts there (mark `reply-drafts`). Then the box
 * saves through the forward exactly as it saves here, and the draft is the same one on every window of both machines
 * (docs/agent-guides/inbox-machines.md, "Reply drafts"). An older Plannotator there keeps none: the words stay in the
 * box only, and dictated words for a closed box wait in this page, as before.
 */
import { hasMachineMark, machineOf, onLinkedMachines } from './inboxUrl';

/** Files a far thread's draft did not take, refused on the box's tiles (lostDraftFiles.ts). */
export { lostDraftFilesOf } from './lostDraftFiles';

export function keepsReplyDraft(threadId: string | null | undefined): boolean {
  return hasMachineMark(machineOf(threadId), 'reply-drafts');
}

/**
 * What the Inbox hands the reply draft client (replyDraft.ts): which threads' drafts are kept, when that may change,
 * and which threads live on a linked machine (their words wait in the page while that machine keeps no draft).
 */
export const replyDraftHost = { canPersist: keepsReplyDraft, onPersistenceChange: onLinkedMachines, isRemote: (threadId: string) => machineOf(threadId) !== null } as const;
