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

/** A Side's quote in the box and the line saying where its words came from (sideSource.ts). */
export interface AskSource {
  quote: string;
  line: string;
}

const sourcesKey = (threadId: string): string => `plannotator-inbox-ask-sources:${threadId}`;

/** The sources of the Side quotes put in this thread's box and not sent yet, kept beside its words. */
export function readAskSources(threadId: string): AskSource[] {
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(sourcesKey(threadId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is AskSource => !!s && typeof s.quote === 'string' && typeof s.line === 'string') : [];
  } catch {
    return [];
  }
}

export function saveAskSources(threadId: string, sources: readonly AskSource[]): void {
  try {
    if (sources.length) window.sessionStorage.setItem(sourcesKey(threadId), JSON.stringify(sources));
    else window.sessionStorage.removeItem(sourcesKey(threadId));
  } catch {
    // Storage full or off: the sources stay for as long as the box is on screen.
  }
}

/** The source lines of the quotes the question still holds (a quote the person deleted takes its line with it), or undefined. */
export function askSourceFor(question: string, sources: readonly AskSource[]): string | undefined {
  const lines = [...new Set(sources.filter((s) => question.includes(s.quote)).map((s) => s.line))];
  return lines.length ? lines.join('\n') : undefined;
}
