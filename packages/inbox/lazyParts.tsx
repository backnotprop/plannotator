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

import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { diffDrawReady, diffLanguages, diffReadyNow } from './threadDrawReady';

type Loaded<P> = { default: ComponentType<P> };

/**
 * A lazy component that renders synchronously once its module is in, and the
 * `preload` that brings it in. A failed load reaches the caller's
 * LazyBlockBoundary and is forgotten by `preload`. React.lazy keeps its
 * rejection for good, so a host that offers the part again after a failure
 * (the next ⌘K, the next Post) calls `retry()` first: the next mount then asks
 * for the chunk again. Without it the part stays failed until Reload.
 */
export function lazyPart<P extends object>(load: () => Promise<Loaded<P>>) {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<Loaded<P>> | null = null;
  let failed = false;
  const preload = (): Promise<Loaded<P>> =>
    (pending ??= load().then(
      (mod) => {
        loaded = mod.default;
        return mod;
      },
      (cause: unknown) => {
        pending = null;
        failed = true;
        throw cause;
      },
    ));
  let Lazy = lazy(preload);
  const retry = () => {
    if (!failed) return;
    failed = false;
    Lazy = lazy(preload);
  };
  function Part(props: P) {
    const Ready = loaded;
    const Pending = Lazy;
    return Ready ? <Ready {...props} /> : <Pending {...props} />;
  }
  return { Part, preload, retry, isLoaded: () => loaded !== null };
}

/**
 * A part drawn in a pane (the review reader, the Shape board): one whose chunk cannot arrive says so in the
 * pane with ui's notice and Reload, and the window stays as it is. `loading`: what shows while it arrives.
 */
export function PanePart({ children, loading = null }: { children: ReactNode; loading?: ReactNode }) {
  return (
    <LazyBlockBoundary fallback={(notice) => <div className="ib-gerror">{notice}</div>}>
      <Suspense fallback={loading}>{children}</Suspense>
    </LazyBlockBoundary>
  );
}

/**
 * The review reader in a pane (GuidePane, ReviewPane, PullReview): drawn once its chunk is in and its diff's
 * grammars are attached in the diff themes (threadDrawReady.ts), so no diff line paints plain first. Both
 * already in (the usual case once the window has been idle): it draws in the same commit.
 */
export function ReaderPart({ diff, children }: { diff: string; children: ReactNode }) {
  const langs = useMemo(() => diffLanguages(diff), [diff]);
  const [waited, setWaited] = useState<readonly string[] | null>(null);
  const show = waited === langs || (GuideReaderPart.isLoaded() && diffReadyNow(langs));
  useEffect(() => {
    if (show) return;
    let live = true;
    // A reader that cannot load still draws: its boundary then says so.
    void Promise.all([diffDrawReady(langs), GuideReaderPart.preload().catch(() => undefined)]).then(() => {
      if (live) setWaited(langs);
    });
    return () => {
      live = false;
    };
  }, [langs, show]);
  return <PanePart>{show ? children : null}</PanePart>;
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
