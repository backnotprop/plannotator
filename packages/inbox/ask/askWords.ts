/**
 * Words typed into the Ask AI box and not sent yet: kept per thread in
 * sessionStorage, so leaving a thread, a reload or a failed question never
 * loses them. The box clears only when the question was saved.
 */
const key = (threadId: string): string => `plannotator-inbox-ask-words:${threadId}`;

export function readAskWords(threadId: string): string {
  try {
    return window.sessionStorage.getItem(key(threadId)) ?? '';
  } catch {
    return '';
  }
}

export function saveAskWords(threadId: string, words: string): void {
  try {
    if (words) window.sessionStorage.setItem(key(threadId), words);
    else window.sessionStorage.removeItem(key(threadId));
  } catch {
    // Storage full or off: the words stay in the box for as long as it is on screen.
  }
}
