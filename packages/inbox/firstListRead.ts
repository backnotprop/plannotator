/** Retried until it lands: the live stream starts at the first read's cursor, so a failed first read would leave the page never listening. */

export const FIRST_LIST_RETRY_MS = [250, 1000, 2000, 4000, 5000] as const;

export interface FirstListReadDeps<T> {
  read: () => Promise<T | null>;
  landed: () => T | null;
  refused: () => boolean;
  cancelled: () => boolean;
  wait: (ms: number) => Promise<void>;
  onLateLanding?: () => void;
}

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

export function listReadRefused(cause: unknown): boolean {
  const status = (cause as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}
