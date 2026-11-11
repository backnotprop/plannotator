/** Parts are fetched once the window is idle: a bare React.lazy suspends on first open and React holds the Suspense fallback at least 300 ms, so a loaded part renders at once, never through Suspense. */

import { lazy, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import { diffDrawReady, diffLanguages, diffReadyNow } from './threadDrawReady';

type Loaded<P> = { default: ComponentType<P> };

/** A lazy component that renders synchronously once its module is in. React.lazy keeps its rejection for good, so a host offering the part again after a failure calls `retry()` first. */
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

function Failed({ run }: { run: () => void }) {
  useEffect(run, [run]);
  return null;
}

export function PanePart({ children, loading = null, onFailed }: { children: ReactNode; loading?: ReactNode; onFailed?: () => void }) {
  return (
    <LazyBlockBoundary
      fallback={(notice) => (
        <div className="ib-gerror">
          {notice}
          {onFailed && <Failed run={onFailed} />}
        </div>
      )}
    >
      <Suspense fallback={loading}>{children}</Suspense>
    </LazyBlockBoundary>
  );
}

export function ReaderPart({ diff, children }: { diff: string; children: ReactNode }) {
  const langs = useMemo(() => diffLanguages(diff), [diff]);
  const [waited, setWaited] = useState<readonly string[] | null>(null);
  const show = waited === langs || (GuideReaderPart.isLoaded() && diffReadyNow(langs));
  useEffect(() => {
    if (show) return;
    let live = true;
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
export const PullAllFilesPart = lazyPart(() => import('#guide-reader').then((mod) => ({ default: mod.PullAllFiles })));
export const PullRepoFilePart = lazyPart(() => import('#guide-reader').then((mod) => ({ default: mod.PullRepoFile })));
export const ShapeBoardPart = lazyPart(() => import('#shape-board'));
export const SearchPalettePart = lazyPart(() => import('#search-palette'));
export const PlatformPostPart = lazyPart(() => import('#platform-post'));

const PARTS = [GuideReaderPart, ShapeBoardPart, SearchPalettePart, PlatformPostPart];

export function WarmWindowParts() {
  useEffect(() => {
    let cancelled = false;
    let cancel = () => {};
    const next = (i: number) => {
      if (cancelled || i >= PARTS.length) return;
      const run = () => {
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
