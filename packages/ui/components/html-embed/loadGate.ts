/**
 * How many live HTML embeds a page runs, and when they load (approval
 * "inbox-inline-html"; the gate Workspaces settled on for its previews):
 * - a frame loads only once it comes within `EMBED_NEAR_PX` of the screen;
 * - at most `EMBED_CONCURRENT_LOADS` load at once, each holding its permit
 *   until its document has loaded (or `EMBED_LOAD_TIMEOUT_MS` passed);
 * - at most `EMBED_LIVE_MAX` are live at once; past that an embed waits as
 *   a "Show page" button until the person asks or a live one goes away.
 */

import { useEffect, useState, type RefObject } from 'react';

export const EMBED_NEAR_PX = 400;
export const EMBED_CONCURRENT_LOADS = 2;
export const EMBED_LIVE_MAX = 12;
export const EMBED_LOAD_TIMEOUT_MS = 8000;

let loading = 0;
const waiting: Array<() => void> = [];

/** Wait for a load permit; call the release it resolves to once the frame has loaded. */
export function acquireEmbedLoad(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      loading += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        loading -= 1;
        waiting.shift()?.();
      };
      setTimeout(release, EMBED_LOAD_TIMEOUT_MS);
      resolve(release);
    };
    if (loading < EMBED_CONCURRENT_LOADS) grant();
    else waiting.push(grant);
  });
}

let live = 0;
const liveListeners = new Set<() => void>();

/** Take a live slot; false when `EMBED_LIVE_MAX` are already live (unless `force`, the person's own ask). */
export function claimEmbedLive(force = false): boolean {
  if (!force && live >= EMBED_LIVE_MAX) return false;
  live += 1;
  return true;
}

export function releaseEmbedLive(): void {
  live = Math.max(0, live - 1);
  for (const listener of [...liveListeners]) listener();
}

/** Called when a live slot frees up, so a waiting embed can try again. */
export function onEmbedLiveFreed(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

/** For tests: forget every permit and slot. */
export function resetEmbedGateForTests(): void {
  loading = 0;
  waiting.length = 0;
  live = 0;
  liveListeners.clear();
}

/** The nearest ancestor that scrolls vertically, or null for the page itself. */
function scrollParentOf(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

/**
 * True once the element has come within `EMBED_NEAR_PX` of the screen (and
 * stays true). Measured against the pane that scrolls it: a margin on the
 * viewport would stop at the pane's clip.
 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: scrollParentOf(el), rootMargin: `${EMBED_NEAR_PX}px 0px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}
