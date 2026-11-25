/**
 * The words typed in a linked computer's thread whose draft is not kept there (an older Plannotator there, or its list
 * not read yet, so its marks are not known; machineDrafts.ts). Nothing is sent for such a thread: its words are kept in
 * this page per thread (and in browser storage, replyWordsKept.ts), so leaving the thread and coming back keeps them, and
 * the restart guard and "Leave page?" ask. Once that computer keeps drafts they leave here, once, and the reply draft
 * client (replyDraft.ts `remoteToDraft`) saves them there as words not saved yet, or shows the conflict.
 */
import { machineOf } from './inboxUrl';

export const remoteWords = new Map<string, string>();

/** Another machine's threads with words kept here (a thread no longer marked as that machine's keeps none here). */
export const remoteKept = (): boolean => [...remoteWords.keys()].some((threadId) => machineOf(threadId) !== null);

/** The box's words for such a thread: kept, or let go when it is emptied. */
export function keepRemoteWords(threadId: string, text: string): void {
  if (text.trim() !== '') remoteWords.set(threadId, text);
  else remoteWords.delete(threadId);
}

/** That computer keeps drafts now (the host's `canPersist`): the thread's kept words leave here (undefined: none, or still not kept there). */
export function remoteWordsToSave(threadId: string, canPersist: (threadId: string) => boolean): string | undefined {
  const words = remoteWords.get(threadId);
  if (words === undefined || !canPersist(threadId)) return undefined;
  remoteWords.delete(threadId);
  return words;
}
