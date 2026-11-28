/**
 * What a failure box's Reload sends before the page goes (RegionBoundary.tsx): a save that waits for a pause in typing
 * (a code review's comments, saved half a second after the last change) registers its flush here, and Reload waits
 * for every one of them, up to `limitMs`, before it reloads. A save that fails, or takes too long, does not hold the
 * page: Reload still happens.
 */

type Flush = () => unknown;

const flushes = new Set<Flush>();

/** Send this before a failure box reloads the page. Returns the undo (an unmount). */
export function flushBeforeReload(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Every registered flush, together, then `reload` (the page's own by default), no later than `limitMs`. */
export async function reloadAfterFlush(reload: () => void = () => window.location.reload(), limitMs = 2000): Promise<void> {
  const sent = Promise.allSettled([...flushes].map(async (flush) => flush()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([sent, new Promise<void>((done) => (timer = setTimeout(done, limitMs)))]);
  if (timer !== undefined) clearTimeout(timer);
  reload();
}
