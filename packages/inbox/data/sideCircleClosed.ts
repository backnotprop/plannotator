/**
 * A thread's minimized side chat whose circle the person closed (the owner, 2026-11-21: right-click the circle,
 * Close: "Hide the circle and keep the conversation. It comes back if the agent answers, or when you start a side chat
 * on that thread again"). Nothing on the server changes: the conversation file stays as it was.
 *
 * Kept per thread in sessionStorage, as the chat's unsent words are (ask/askWords.ts): a reload in this tab keeps the
 * circle closed, another tab or a new browser session shows it again. What is kept is the newest answer's time when
 * Close was chosen ('' with no answer yet): a later answer differs from it, so the circle is back (`sideCircleClosed`)
 * whenever the read says the agent answered since, even one that landed while the thread was not on screen.
 */

const PREFIX = 'plannotator-inbox-side-closed:';
const key = (threadId: string): string => `${PREFIX}${threadId}`;
const listeners = new Set<() => void>();

/** What Close kept for this thread (the newest answer's time then, '' for none), or null when its circle is not closed. */
export function readSideClosed(threadId: string): string | null {
  try {
    // Full storage refuses the write but reads fine: the page's own copy still counts.
    return window.sessionStorage.getItem(key(threadId)) ?? memory.get(threadId) ?? null;
  } catch {
    return memory.get(threadId) ?? null;
  }
}

/** Storage off or full: closed for as long as this page lives. */
const memory = new Map<string, string>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Close on the circle: hidden until an answer newer than `newestAnswer` comes, or a side chat opens on this thread. */
export function closeSideCircle(threadId: string, newestAnswer: string | null): void {
  const mark = newestAnswer ?? '';
  memory.set(threadId, mark);
  try {
    window.sessionStorage.setItem(key(threadId), mark);
  } catch {
    // The page's own copy holds it.
  }
  emit();
}

/** The circle is back for this thread (a side chat opened on it, or the agent answered). Nothing when it was not closed. */
export function reopenSideCircle(threadId: string): void {
  if (readSideClosed(threadId) === null) return;
  memory.delete(threadId);
  try {
    window.sessionStorage.removeItem(key(threadId));
  } catch {
    // Only the page's copy, gone above.
  }
  emit();
}

/** The useSyncExternalStore seam: a Close or a reopen in this window. */
export function subscribeSideClosed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Closed still: Close was chosen (`kept` not null) and no answer came since (the newest answer is the one it kept). Pure. */
export function sideCircleClosed(kept: string | null, newestAnswer: string | null): boolean {
  return kept !== null && kept === (newestAnswer ?? '');
}
