import { useEffect, useState, type RefObject } from 'react';

export const EMBED_NEAR_PX = 400;
export const EMBED_CONCURRENT_LOADS = 2;
export const EMBED_LIVE_MAX = 12;
export const EMBED_LOAD_TIMEOUT_MS = 8000;

let loading = 0;
const waiting: Array<() => void> = [];

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

export function claimEmbedLive(force = false): boolean {
  if (!force && live >= EMBED_LIVE_MAX) return false;
  live += 1;
  return true;
}

export function releaseEmbedLive(): void {
  live = Math.max(0, live - 1);
  for (const listener of [...liveListeners]) listener();
}

export function onEmbedLiveFreed(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => liveListeners.delete(listener);
}

export function resetEmbedGateForTests(): void {
  loading = 0;
  waiting.length = 0;
  live = 0;
  liveListeners.clear();
}

function scrollParentOf(el: Element): Element | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return node;
  }
  return null;
}

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
