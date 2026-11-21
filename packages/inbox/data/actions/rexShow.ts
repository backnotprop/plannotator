/**
 * Show in Rex (packages/server/inbox-rex.ts): Rex's app goes to the pane a live session lives in. For a linked
 * machine's agent the ask goes to that machine's Inbox (its Rex holds the pane) through the machine link
 * (packages/server/inbox-rex-far.ts), sent now or not at all.
 */
import { useSyncExternalStore } from 'react';
import { post } from '../../api';
import { dropRexShow } from '../../agentsList';
import { inboxUrl } from '../../inboxUrl';

/** Said under the agent's row when Rex's app was asked and did not go there (its Remote Control setting is off). */
export const REX_SHOW_REFUSED = "Rex didn't show it. Turn on Remote Control in Rex's settings.";
/** Said when the pane or the app is gone. */
export const REX_SHOW_FAILED = "Rex didn't show it.";
/** How long the line stays under the row. */
export const REX_SHOW_NOTE_MS = 8_000;

/** The one line a failed Show leaves under its agent's row, for a short while. */
let note: { session: string; text: string } | null = null;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
function setNote(next: typeof note) {
  note = next;
  if (noteTimer) clearTimeout(noteTimer);
  noteTimer = next ? setTimeout(() => setNote(null), REX_SHOW_NOTE_MS) : null;
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The line under `session`'s row after a failed Show, while it lasts; null otherwise. */
export function useRexShowNote(session: string): string | null {
  return useSyncExternalStore(subscribe, () => (note?.session === session ? note.text : null));
}

/**
 * Ask for it, on the person's click. When Rex did not go there, a line under the agent's row says so (and the
 * window's live region says it too), and the item leaves the agent's menu until Rex's app confirms a jump again.
 */
export function showInRex(session: string, announce?: (text: string) => void, machine: string | null = null): void {
  setNote(null);
  const failed = (text: string) => {
    dropRexShow(session);
    setNote({ session, text });
    announce?.(text);
  };
  void post<{ shown?: unknown; refused?: unknown }>(inboxUrl('/rex/show', undefined, machine), { session }).then(
    (answer) => {
      if (answer.shown !== true) failed(answer.refused === true ? REX_SHOW_REFUSED : REX_SHOW_FAILED);
    },
    () => failed(REX_SHOW_FAILED),
  );
}
