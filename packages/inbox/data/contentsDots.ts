/**
 * "Annotation minimap" (Settings → General → Appearance; on by default): whether a document's contents rail draws its
 * comments as dots beside the heading ticks and at the end of the open panel's rows (ui's `MarkdownContentsRail`
 * marks). Off, the rail is drawn exactly as without marks: its ticks and its panel stay. Read by every rail the Inbox
 * mounts (parts/FileContentsRail.tsx: a file beside a thread or full screen, a Markdown plan on the Plans page, and a plan's other pages).
 *
 * A cookie, like the rail's own shown or hidden (contents.ts) and the Inbox's other window-only layout choices:
 * cookies ignore the port, so the choice holds when the Inbox comes back on another port. One store in the window, so
 * Settings' switch and an open rail never disagree.
 */
import { useSyncExternalStore } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

export const CONTENTS_DOTS_COOKIE = 'plannotator-inbox-contents-dots';

/** The switch's words (Settings' row). */
export const CONTENTS_DOTS_LABEL = 'Annotation minimap';
export const CONTENTS_DOTS_DESC = 'Each comment as a dot beside its heading on the contents rail.';

const listeners = new Set<() => void>();

/** Whether the rail draws comment dots now: on unless turned off. */
export function contentsDotsShown(): boolean {
  return storage.getItem(CONTENTS_DOTS_COOKIE) !== 'hidden';
}

export function subscribeContentsDots(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Turn the dots on or off: saved, and every rail in this window redraws. */
export function setContentsDotsShown(shown: boolean): void {
  storage.setItem(CONTENTS_DOTS_COOKIE, shown ? 'shown' : 'hidden');
  for (const listener of listeners) listener();
}

export function useContentsDotsShown(): boolean {
  return useSyncExternalStore(subscribeContentsDots, contentsDotsShown, contentsDotsShown);
}
