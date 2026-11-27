/**
 * Close's Undo for as long as the server takes it (approval "inbox-pr-board-close-safe"): each Close the board made is
 * kept here, with its repositories' names, until the server's reopen window (`INBOX_PULL_REOPEN_WINDOW_MS`, the one the
 * route checks) ends after its first PR closed. The board draws one quiet line per Close under its bar (ClosedLines.tsx).
 *
 * Kept outside the page, so the line outlives another toast, the picks, select mode, and the board leaving the screen
 * and coming back. Undo takes a Close out before it reopens anything, so a second press (the toast's and the line's)
 * reopens nothing twice; what the server could not reopen for a reason that may pass (a machine asleep, the forge not
 * answering) comes back to the line.
 *
 * When the window ends, Undo goes at once (`ended`), but the line's words stay until the board lets them go
 * (`dropEnded`: the pointer is not over the board, or it leaves it, or the view changes), so nothing moves
 * under the pointer.
 */
import { useSyncExternalStore } from 'react';
import { INBOX_PULL_REOPEN_WINDOW_MS, type InboxPull } from '@plannotator/core/inbox-types';

export interface ClosedBatch {
  id: number;
  /** When the server's window for this Close ends (ms since the epoch). */
  until: number;
  /** What this Close closed, in the order closed. */
  pulls: readonly InboxPull[];
  /** The repositories' names on the board when it closed (a section may be gone since). */
  repos: Readonly<Record<string, string>>;
  /** The window ended: no Undo any more; the words wait for `dropEnded`. */
  ended?: boolean;
}

let batches: readonly ClosedBatch[] = [];
let nextId = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: readonly ClosedBatch[]): void {
  batches = next;
  if (timer) clearTimeout(timer);
  timer = null;
  const live = batches.filter((b) => !b.ended);
  if (live.length > 0) {
    const soonest = Math.min(...live.map((b) => b.until));
    timer = setTimeout(() => publish(batches.map((b) => (!b.ended && b.until <= soonest ? { ...b, ended: true } : b))), Math.max(0, soonest - Date.now()));
  }
  for (const listener of listeners) listener();
}

/** A Close went: keep it from `closedAt` (its first PR's close) for the server's window. */
export function keepClosed(pulls: readonly InboxPull[], closedAt: number, repos: Readonly<Record<string, string>>): ClosedBatch {
  const batch = { id: nextId++, until: closedAt + INBOX_PULL_REOPEN_WINDOW_MS, pulls, repos };
  publish([batch, ...batches]);
  return batch;
}

/** Undo pressed: the Close leaves the line, once. Null when it is gone already (undone, or its window ended). */
export function takeClosed(id: number): ClosedBatch | null {
  const batch = batches.find((b) => b.id === id && !b.ended) ?? null;
  if (batch) publish(batches.filter((b) => b !== batch));
  return batch;
}

/** What Undo could not reopen for now comes back to the line, for the rest of its window. */
export function putBackClosed(batch: ClosedBatch, pulls: readonly InboxPull[]): void {
  if (pulls.length === 0 || batch.until <= Date.now()) return;
  publish([{ ...batch, pulls }, ...batches]);
}

/** The board let go of the lines whose window ended (see the top). */
export function dropEnded(): void {
  if (batches.some((b) => b.ended)) publish(batches.filter((b) => !b.ended));
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const read = () => batches;

/** The Closes whose Undo still holds, newest first. */
export function useClosedBatches(): readonly ClosedBatch[] {
  return useSyncExternalStore(subscribe, read, read);
}

/** Tests: nothing kept. */
export function forgetClosed(): void {
  publish([]);
}
