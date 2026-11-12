import { useCallback, useState } from 'react';
import { storage } from '../utils/storage';

export type TreeScope = 'changes' | 'all';

export const TREE_SCOPE_COOKIE = 'plannotator-review-tree-scope';

export function readTreeScope(): TreeScope {
  return storage.getItem(TREE_SCOPE_COOKIE) === 'all' ? 'all' : 'changes';
}

export function useTreeScope(): [TreeScope, (scope: TreeScope) => void] {
  const [scope, setScopeState] = useState<TreeScope>(readTreeScope);
  const setScope = useCallback((next: TreeScope) => {
    if (next === 'all') storage.setItem(TREE_SCOPE_COOKIE, 'all');
    else storage.removeItem(TREE_SCOPE_COOKIE);
    setScopeState(next);
  }, []);
  return [scope, setScope];
}
