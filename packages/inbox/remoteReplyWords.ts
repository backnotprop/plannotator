/**
 * The words typed in a linked computer's thread whose draft is not kept there (an older Plannotator there, or its list
 * not read yet, so its marks are not known; machineDrafts.ts). Nothing is sent for such a thread: its words are kept in
 * this page per thread (and in browser storage, replyWordsKept.ts), so leaving the thread and coming back keeps them, and
 * the restart guard and "Leave page?" ask. Once that computer keeps drafts they leave here, once, and the reply draft
 * client (replyDraft.ts `remoteToDraft`) saves them there as words not saved yet, or shows the conflict. Which threads
 * live elsewhere is the host's to say (`isRemote`): nothing here knows linked machines.
 */
export const remoteWords = new Map<string, string>();

/** The host's `isRemote` (replyDraft.ts `ReplyDraftOptions`, the last hook given one; none by default). */
let remote: (threadId: string) => boolean = () => false;
export const isRemoteThread = (threadId: string): boolean => remote(threadId);
export function setRemoteThreads(isRemote: (threadId: string) => boolean): void {
  remote = isRemote;
}

/** Remote threads with words kept here (a thread the host no longer names as remote keeps none here). */
export const remoteKept = (): boolean => [...remoteWords.keys()].some(isRemoteThread);

/** The box's words for such a thread: kept, or let go when it is emptied. */
export function keepRemoteWords(threadId: string, text: string): void {
  if (text.trim() !== '') remoteWords.set(threadId, text);
  else remoteWords.delete(threadId);
}

/**
 * That computer keeps drafts now (the host's `canPersist`): the thread's kept words, to save there (undefined: none, or
 * still not kept there). They stay here until the caller has kept them elsewhere, then it lets them go.
 */
export function remoteWordsToSave(threadId: string, canPersist: (threadId: string) => boolean): string | undefined {
  const words = remoteWords.get(threadId);
  if (words === undefined || !canPersist(threadId)) return undefined;
  return words;
}

/** DOM tests: no host says which threads are remote (as a new page has it). */
export function resetRemoteThreadsForTests(): void {
  remote = () => false;
}
