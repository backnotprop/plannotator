import { useCallback, useState } from 'react';
import { storage } from '@plannotator/ui/utils/storage';

/**
 * The Tree view's Changes | All files switch (approved design record
 * "review-explorer", answer 1): a review opens on Changes, as before; once
 * someone picks All files it is remembered for this browser. Cookie-only on
 * purpose, like `plannotator-review-group-by-kind`: the settings registry is
 * bundled into the pinned guides.show viewer.
 */
export type TreeScope = 'changes' | 'all';

export const TREE_SCOPE_COOKIE = 'plannotator-review-tree-scope';

export function readTreeScope(): TreeScope {
  return storage.getItem(TREE_SCOPE_COOKIE) === 'all' ? 'all' : 'changes';
}

export function useTreeScope(): [TreeScope, (scope: TreeScope) => void] {
  const [scope, setScopeState] = useState<TreeScope>(readTreeScope);
  const setScope = useCallback((next: TreeScope) => {
    // Changes, the default, is the absence of the cookie.
    if (next === 'all') storage.setItem(TREE_SCOPE_COOKIE, 'all');
    else storage.removeItem(TREE_SCOPE_COOKIE);
    setScopeState(next);
  }, []);
  return [scope, setScope];
}
