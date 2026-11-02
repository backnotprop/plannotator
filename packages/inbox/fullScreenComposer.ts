/**
 * The full-screen composer's per-thread state (approval
 * "inbox-fullscreen-composer", 2A, round 4): which tab it shows (a comment on
 * the file, or the thread's reply) and whether the person minimized it to its
 * pill. Kept per thread for the window's life, outside the components: the
 * composer is drawn by the image, film and HTML views, which come and go as
 * the person steps through files, leaves full screen and comes back.
 *
 * The words are not kept here. The reply tab writes the thread's own reply
 * draft (Thread.tsx), and the comment tab is the file's own comment row.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type ComposerMode = 'comment' | 'reply';

/** The tab the person picked, per thread. Absent: the default (composerModeFor). */
const picked = new Map<string, ComposerMode>();
/** The person's minimize or restore, per thread. Absent: the view's default (`composerMinimized`). */
const minimized = new Map<string, boolean>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * The tab the composer shows for a thread: the person's pick, else Reply when
 * a reply draft waits (they were writing to the agent), else Comment (the file
 * is what is on screen). A view that takes no comment is Reply only (HTML, until a phone's pin or selection
 * gives it one: useHtmlPageComment).
 */
export function composerModeFor(threadId: string, hasDraft: boolean, takesComments: boolean): ComposerMode {
  if (!takesComments) return 'reply';
  return picked.get(threadId) ?? (hasDraft ? 'reply' : 'comment');
}

export function pickComposerMode(threadId: string, mode: ComposerMode): void {
  if (picked.get(threadId) === mode) return;
  picked.set(threadId, mode);
  changed();
}

/**
 * Whether the card is folded to its pill: the person's choice, else the view's default. `foldedByDefault`: an
 * HTML page on a phone opens clear, like Markdown, with the reply in the pill.
 */
export function composerMinimized(threadId: string, foldedByDefault = false): boolean {
  return minimized.get(threadId) ?? foldedByDefault;
}

export function setComposerMinimized(threadId: string, on: boolean): void {
  if (minimized.get(threadId) === on) return;
  minimized.set(threadId, on);
  changed();
}

/** An HTML page opens on a phone: a card the person opened on the last file does not carry over (a pick to fold it stays). */
export function forgetComposerOpened(threadId: string): void {
  if (minimized.get(threadId) !== false) return;
  minimized.delete(threadId);
  changed();
}

/** A comment on an HTML page opens the card on its Comment tab. Returns what puts back the tab and the fold it found. */
export function openComposerComment(threadId: string): () => void {
  const hadTab = picked.get(threadId);
  const hadFold = minimized.get(threadId);
  showComposerComment(threadId);
  return () => {
    if (hadTab === undefined) picked.delete(threadId);
    else picked.set(threadId, hadTab);
    if (hadFold === undefined) minimized.delete(threadId);
    else minimized.set(threadId, hadFold);
    changed();
  };
}

/** The card, unfolded, on its Comment tab. */
export function showComposerComment(threadId: string): void {
  picked.set(threadId, 'comment');
  minimized.set(threadId, false);
  changed();
}

/** Tests only: forget every thread's tab and minimized state. */
export function resetComposerState(): void {
  picked.clear();
  minimized.clear();
  changed();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The thread's tab and minimized state, redrawn when either changes. */
export function useComposerState(threadId: string, hasDraft: boolean, takesComments: boolean, foldedByDefault = false) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const setMode = useCallback((mode: ComposerMode) => pickComposerMode(threadId, mode), [threadId]);
  const setMinimized = useCallback((on: boolean) => setComposerMinimized(threadId, on), [threadId]);
  return {
    mode: composerModeFor(threadId, hasDraft, takesComments),
    setMode,
    minimized: composerMinimized(threadId, foldedByDefault),
    setMinimized,
  };
}
