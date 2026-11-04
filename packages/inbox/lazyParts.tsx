/**
 * The window's parts loaded on first use (#2593): the guided/code review
 * reader, the Shape board, the search palette and the post dialog.
 *
 * Each is a chunk the Inbox serves (build/pack-inbox.ts). Through a bare
 * React.lazy, the first open suspends while its chunk arrives, and React holds
 * a Suspense boundary's fallback at least 300 ms before it reveals the content
 * (its fallback throttle): a guided review then took ~345 ms to draw its diff
 * where the inline bundle drew it in ~50 ms. So the parts are fetched once the
 * window is idle (WarmWindowParts, ~0.5 MB of script in all; the diagram
 * runtimes, KaTeX and the grammars stay on first use), and a part already
 * loaded renders at once, never through Suspense.
 */

import { lazy, useEffect, type ComponentType } from 'react';

type Loaded<P> = { default: ComponentType<P> };

/**
 * A lazy component that renders synchronously once its module is in, and the
 * `preload` that brings it in. A failed load is forgotten, so the next render
 * (or Reload) tries again; it reaches the caller's LazyBlockBoundary.
 */
export function lazyPart<P extends object>(load: () => Promise<Loaded<P>>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<Loaded<P>> | null = null;
  const preload = (): Promise<Loaded<P>> =>
    (pending ??= load().then(
      (mod) => {
        loaded = mod.default;
        return mod;
      },
      (cause: unknown) => {
        pending = null;
        throw cause;
      },
    ));
  const Lazy = lazy(preload);
  function Part(props: P) {
    const Ready = loaded;
    return Ready ? <Ready {...props} /> : <Lazy {...props} />;
  }
  return { Part, preload };
}

export const GuideReaderPart = lazyPart(() => import('#guide-reader'));
export const ShapeBoardPart = lazyPart(() => import('#shape-board'));
export const SearchPalettePart = lazyPart(() => import('#search-palette'));
export const PlatformPostPart = lazyPart(() => import('#platform-post'));

const PARTS = [GuideReaderPart, ShapeBoardPart, SearchPalettePart, PlatformPostPart];

/** Once the window is idle after its first paint: fetch the parts, one per idle slot. Draws nothing. */
export function WarmWindowParts() {
  useEffect(() => {
    let cancelled = false;
    let cancel = () => {};
    const next = (i: number) => {
      if (cancelled || i >= PARTS.length) return;
      const run = () => {
        // A part that cannot load now is tried again when it is opened.
        void PARTS[i]!.preload().catch(() => {}).finally(() => next(i + 1));
      };
      if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(run, { timeout: 3000 });
        cancel = () => cancelIdleCallback(id);
      } else {
        const id = setTimeout(run, 1000);
        cancel = () => clearTimeout(id);
      }
    };
    next(0);
    return () => {
      cancelled = true;
      cancel();
    };
  }, []);
  return null;
}
