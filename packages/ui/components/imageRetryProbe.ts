/**
 * The off-page loads `HostResolvedImage` makes for a picture that failed, when its host asks for a try again
 * (`ImageRetryContext`): at most `MAX_PROBES` at a time in a window, the rest queued in order. A burst (a host's
 * new key over a document with many failed pictures) never takes more than that many of the browser's
 * connections, so the page's own requests keep theirs. A load that never ends gives its slot up after
 * `PROBE_TIMEOUT_MS`, counted as failed.
 */

const MAX_PROBES = 4;
export const PROBE_TIMEOUT_MS = 30_000;
let running = 0;
const queued: (() => void)[] = [];

/**
 * Loads `src` off the page, now or when a slot frees, and calls `done` with whether it loaded. The returned cancel
 * drops it from the queue, or (already loading) stops `done` and clears the probe's src so the browser can drop
 * the request: the slot is freed when that load ends, or at the timeout.
 */
export function probeImage(src: string, done: (loaded: boolean) => void): () => void {
  let cancelled = false;
  let probe: HTMLImageElement | null = null;
  const start = () => {
    running += 1;
    const image = new Image();
    probe = image;
    let settled = false;
    const settle = (loaded: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      probe = null;
      running -= 1;
      queued.shift()?.();
      if (!cancelled) done(loaded);
    };
    const timer = setTimeout(() => settle(false), PROBE_TIMEOUT_MS);
    image.onload = () => settle(true);
    image.onerror = () => settle(false);
    image.src = src;
  };
  if (running < MAX_PROBES) start();
  else queued.push(start);
  return () => {
    cancelled = true;
    const at = queued.indexOf(start);
    if (at >= 0) queued.splice(at, 1);
    if (probe) probe.src = '';
  };
}
