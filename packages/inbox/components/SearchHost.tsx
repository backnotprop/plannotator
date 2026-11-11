import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SearchPalettePart } from '../lazyParts';
import { LazyBlockBoundary } from '@plannotator/ui/components/LazyBlockBoundary';
import type { SearchPaletteProps } from '../search/SearchPalette';

const SearchPalette = SearchPalettePart.Part;

export type { SearchLanding } from '../search/SearchPalette';

function OnCommit({ run }: { run: () => void }) {
  useEffect(run, [run]);
  return null;
}

export function SearchHost(props: SearchPaletteProps & { mounted: boolean }) {
  const { mounted, ...palette } = props;
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
