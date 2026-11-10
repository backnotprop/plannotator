/**
 * The window's first read of the list, read again while it fails.
 *
 * The page listens to the Inbox's live stream only once that first read has
 * landed (the stream starts at the read's cursor). One failed read (a dropped
 * connection as the page loads, the Inbox still starting, a phone's network
 * for a moment) used to end it there: the window showed the failure's words
 * and nothing else, and never listened. Worse with a thread link: the thread's
 * own read is retried, and its look reads the list again, so the page then
 * looked whole while no new message could ever reach it. Either way only a
 * reload mended it.
 *
 * So the read is tried again after `FIRST_LIST_RETRY_MS`, then every last
 * one, until it lands (the waits an open thread's failed read already uses,
 * App.tsx `THREAD_READ_RETRY_MS`). A list another read put on screen meanwhile
 * (`landed`) is taken as it is. It stops when the page leaves (`cancelled`),
 * and when the Inbox refused the read (`refused`: an answer no retry changes).
 */

/** The waits before each new try of the first list read; the last one repeats. */
export const FIRST_LIST_RETRY_MS = [250, 1000, 2000, 4000, 5000] as const;

export interface FirstListReadDeps<T> {
  /** One read of the list; null when it failed. */
  read: () => Promise<T | null>;
  /** A list some other read already brought (null: none yet). */
  landed: () => T | null;
  /** The last failure is the Inbox's refusal of this page: asking again changes nothing. */
  refused: () => boolean;
  /** The page left (the effect ended): nothing more is read. */
  cancelled: () => boolean;
  /** Wait before the next try (the page's own timer, cleared when it leaves). */
  wait: (ms: number) => Promise<void>;
  /** A try after the first one landed: what the first read's failure also took down is read again. */
  onLateLanding?: () => void;
}

/** The first list, however many tries it takes; null when the page left or the Inbox refused it. */
export async function readFirstList<T>(deps: FirstListReadDeps<T>): Promise<T | null> {
  let first: T | null = await deps.read();
  for (let attempt = 0; !first; attempt++) {
    if (deps.cancelled() || deps.refused()) return null;
    await deps.wait(FIRST_LIST_RETRY_MS[Math.min(attempt, FIRST_LIST_RETRY_MS.length - 1)]!);
    if (deps.cancelled()) return null;
    first = deps.landed() ?? (await deps.read());
    if (first) deps.onLateLanding?.();
  }
  return deps.cancelled() ? null : first;
}

/** Whether a failed list read is the Inbox's own refusal (a 4xx that is not "too early" or "too many"): never retried. */
export function listReadRefused(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}
