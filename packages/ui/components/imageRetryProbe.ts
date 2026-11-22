/**
 * The off-page loads `HostResolvedImage` makes for a picture that failed, when its host asks for a try again
 * (`ImageRetryContext`): at most `MAX_PROBES` at a time in a window, the rest queued in order. A burst (a host's
 * new key over a document with many failed pictures) never takes more than that many of the browser's
 * connections, so the page's own requests keep theirs.
 */

const MAX_PROBES = 4;
let running = 0;
const queued: (() => void)[] = [];

/**
 * Loads `src` off the page, now or when a slot frees, and calls `done` with whether it loaded. The returned cancel
 * drops it from the queue, or (already loading) only stops `done`: the slot is freed when that load ends.
 */
export function probeImage(src: string, done: (loaded: boolean) => void): () => void {
  let cancelled = false;
  const start = () => {
    running += 1;
    const probe = new Image();
    const settle = (loaded: boolean) => {
      probe.onload = null;
      probe.onerror = null;
      running -= 1;
      queued.shift()?.();
      if (!cancelled) done(loaded);
    };
    probe.onload = () => settle(true);
    probe.onerror = () => settle(false);
    probe.src = src;
  };
  if (running < MAX_PROBES) start();
  else queued.push(start);
  return () => {
    cancelled = true;
    const at = queued.indexOf(start);
    if (at >= 0) queued.splice(at, 1);
  };
}
