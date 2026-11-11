import { useCallback, useState } from 'react';
import type { Block } from '@plannotator/ui/types';
import { hasContentsRailHeadings } from '@plannotator/ui/utils/annotationHelpers';
import { storage } from '@plannotator/ui/utils/storage';

export function showsContents(blocks: readonly Block[]): boolean {
  return hasContentsRailHeadings(blocks);
}

export const CONTENTS_COOKIE = 'plannotator-inbox-contents';

/** Its own cookie: plan review's "Auto-open sidebar" (`plannotator-toc-enabled`) is untouched. */
export function useContentsShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShownState] = useState(() => storage.getItem(CONTENTS_COOKIE) !== 'hidden');
  const setShown = useCallback((next: boolean) => {
    setShownState(next);
    storage.setItem(CONTENTS_COOKIE, next ? 'shown' : 'hidden');
  }, []);
  return [shown, setShown];
}
