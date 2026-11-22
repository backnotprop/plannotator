/**
 * A read that a pane repeats while someone can see it: the live sessions, who can be tagged, a waiting reply's
 * connection. Compose's sessions read this way already (compose/useComposeSessions.ts).
 *
 * The read runs now and every `everyMs` while the tab is shown. Nothing runs while the tab is hidden; the moment it is
 * shown again, it reads once and the count starts again from there. A pane kept off the page (`parked`, a free layout
 * too narrow for it) starts no poll at all: its effect starts one when it comes back, which reads once.
 */

/** The tab can be seen (true where there is no document). */
export const tabShown = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/** Starts the poll; returns its stop. */
export function pollWhileShown(read: () => void, everyMs: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    read();
    timer = setInterval(read, everyMs);
  };
  if (tabShown()) start();
  if (typeof document === 'undefined') return stop;
  const visibility = () => {
    if (!tabShown()) stop();
    else if (timer === null) start();
  };
  document.addEventListener('visibilitychange', visibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', visibility);
  };
}
