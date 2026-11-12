import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getAllFolderPaths,
  getAncestorPaths,
  type DiffFileTreeFile,
  type DiffFileTreeNode,
} from '../utils/diffFileTree';

export type DiffFileTreeDefaultExpanded = 'all' | 'none' | readonly string[];

function initialSet(allFolderPaths: string[], defaultExpanded: DiffFileTreeDefaultExpanded): Set<string> {
  if (defaultExpanded === 'all') return new Set(allFolderPaths);
  if (defaultExpanded === 'none') return new Set();
  return new Set(defaultExpanded);
}

export function useDiffFileTreeExpansion<F extends DiffFileTreeFile>(
  tree: DiffFileTreeNode<F>[],
  activePath: string | null | undefined,
  defaultExpanded: DiffFileTreeDefaultExpanded = 'all',
) {
  const allFolderPaths = useMemo(() => getAllFolderPaths(tree), [tree]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => initialSet(allFolderPaths, defaultExpanded));
  const [prevTree, setPrevTree] = useState(tree);

  if (tree !== prevTree) {
    setPrevTree(tree);
    setExpandedFolders(initialSet(allFolderPaths, defaultExpanded));
  }

  useEffect(() => {
    if (activePath) {
      const ancestors = getAncestorPaths(activePath);
      setExpandedFolders((prev) => {
        const missing = ancestors.filter((p) => !prev.has(p));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        for (const p of missing) next.add(p);
        return next;
      });
    }
  }, [activePath, tree]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const setFolderExpanded = useCallback((path: string, expanded: boolean) => {
    setExpandedFolders((prev) => {
      if (prev.has(path) === expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const areAllFoldersExpanded = allFolderPaths.length > 0 && allFolderPaths.every((path) => expandedFolders.has(path));

  const toggleAllFolders = useCallback(() => {
    setExpandedFolders(areAllFoldersExpanded ? new Set() : new Set(allFolderPaths));
  }, [allFolderPaths, areAllFoldersExpanded]);

  return {
    expandedFolders,
    allFolderPaths,
    areAllFoldersExpanded,
    toggleFolder,
    setFolderExpanded,
    toggleAllFolders,
  };
}
