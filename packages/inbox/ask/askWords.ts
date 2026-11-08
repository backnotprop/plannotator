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

/**
 * The words Side puts in the box for a selection: quoted, each line behind `> `, then an empty line where the
 * question goes. Blank lines inside stay in the quote.
 */
export function sideQuote(selected: string): string {
  const text = selected.replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  return `${text.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')}\n\n`;
}
