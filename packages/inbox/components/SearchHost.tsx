/**
 * Where Inbox search's palette lives in the window: its code loads through
 * one dynamic import of `#search-palette` (packages/inbox/search/SearchPalette.tsx),
 * mounted on the first open with no fallback UI and kept mounted after (as
 * Workspaces' AppShell does), so the palette never rides the window's first
 * paint. tests/entry-assets.test.ts keeps every other import of it out.
 * Its chunk is served by the Inbox (build/pack-inbox.ts): one that cannot
 * arrive closes the palette through `onClose` (the window's search state goes
 * back to closed, so the list is as it was), never the window unmounted, and
 * the next open asks for it again.
 */

import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SearchPalettePart } from '../lazyParts';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import type { SearchPaletteProps } from '../search/SearchPalette';

const SearchPalette = SearchPalettePart.Part;

export type { SearchLanding } from '../search/SearchPalette';

/** Draws nothing: calls `run` once, when it commits. */
function OnCommit({ run }: { run: () => void }) {
  useEffect(run, [run]);
  return null;
}

export function SearchHost(props: SearchPaletteProps & { mounted: boolean }) {
  const { mounted, ...palette } = props;
  // `attempt` keys the boundary, a fresh one per open after a failure. `failed`: the last attempt failed and no
  // open has asked again yet, so nothing is mounted (and nothing fetched) while the palette is closed.
  const [load, setLoad] = useState({ attempt: 0, failed: false });
  const onClose = useRef(palette.onClose);
  useLayoutEffect(() => {
    onClose.current = palette.onClose;
  });
  const failed = useCallback(() => {
    SearchPalettePart.retry();
    setLoad((was) => ({ attempt: was.attempt + 1, failed: true }));
    onClose.current('dismissed');
  }, []);
  const loaded = useCallback(() => setLoad((was) => (was.failed ? { ...was, failed: false } : was)), []);
  if (!mounted || (load.failed && !palette.open)) return null;
  return (
    <LazyBlockBoundary key={load.attempt} fallback={() => <OnCommit run={failed} />}>
      <Suspense fallback={null}>
        <SearchPalette {...palette} />
        {load.failed && <OnCommit run={loaded} />}
      </Suspense>
    </LazyBlockBoundary>
  );
}
