import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findReviewSearchMatches,
  groupReviewSearchMatches,
  type ReviewSearchMatch,
  type ReviewSearchableDiffFile,
} from '../utils/reviewSearch';

function getWrappedMatchIndex(matchCount: number, currentIndex: number, direction: 1 | -1): number {
  if (matchCount === 0) return -1;
  if (currentIndex === -1) return 0;
  return (currentIndex + direction + matchCount) % matchCount;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tagName = element.tagName;
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || element.isContentEditable;
}

interface UseReviewSearchOptions {
  files: ReviewSearchableDiffFile[];
  activeFileIndex: number;
  setActiveFileIndex: (index: number) => void;
  clearPendingSelection: () => void;
}

export function useReviewSearch({
  files,
  activeFileIndex,
  setActiveFileIndex,
  clearPendingSelection,
}: UseReviewSearchOptions) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeSearchMatchId, setActiveSearchMatchId] = useState(null as string | null);

  const searchInputRef = useRef(null as HTMLInputElement | null);

  const searchMatches = useMemo(() => {
    return findReviewSearchMatches(files, searchQuery);
  }, [files, searchQuery]);

  const searchGroups = useMemo(() => {
    return groupReviewSearchMatches(files, searchMatches);
  }, [files, searchMatches]);

  const activeSearchMatch = useMemo(() => {
    if (!activeSearchMatchId) return null;
    return searchMatches.find(match => match.id === activeSearchMatchId) ?? null;
  }, [searchMatches, activeSearchMatchId]);

  const activeFileSearchMatches = useMemo(() => {
    const activeFile = files[activeFileIndex];
    if (!activeFile) return [];
    return searchMatches.filter(match => match.filePath === activeFile.path);
  }, [files, activeFileIndex, searchMatches]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setActiveSearchMatchId(null);
    setIsSearchOpen(false);
  }, []);

  const handleSearchInputChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim()) {
      setIsSearchOpen(true);
    }
  }, []);

  const handleSelectSearchMatch = useCallback((matchId: string) => {
    setActiveSearchMatchId(matchId);
  }, []);

  const stepSearchMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;

    const currentIndex = activeSearchMatchId
      ? searchMatches.findIndex(match => match.id === activeSearchMatchId)
      : -1;
    const nextIndex = getWrappedMatchIndex(searchMatches.length, currentIndex, direction);

    setActiveSearchMatchId(nextIndex === -1 ? null : (searchMatches[nextIndex]?.id ?? null));
  }, [searchMatches, activeSearchMatchId]);

  useEffect(() => {
    if (!searchQuery.trim() || searchMatches.length === 0) {
      setActiveSearchMatchId(null);
      return;
    }

    const stillExists = activeSearchMatchId != null
      && searchMatches.some(match => match.id === activeSearchMatchId);

    if (!stillExists) {
      setActiveSearchMatchId(searchMatches[0].id);
    }
  }, [searchQuery, searchMatches, activeSearchMatchId]);

  useEffect(() => {
    if (!activeSearchMatch) return;

    const fileIndex = files.findIndex(file => file.path === activeSearchMatch.filePath);
    if (fileIndex !== -1 && fileIndex !== activeFileIndex) {
      clearPendingSelection();
      setActiveFileIndex(fileIndex);
    }
  }, [activeSearchMatch, files, activeFileIndex, clearPendingSelection, setActiveFileIndex]);

  return {
    searchQuery,
    isSearchOpen,
    activeSearchMatchId,
    activeSearchMatch,
    activeFileSearchMatches,
    searchMatches,
    searchGroups,
    searchInputRef,
    openSearch,
    closeSearch,
    clearSearch,
    stepSearchMatch,
    handleSearchInputChange,
    handleSelectSearchMatch,
  };
}

export type UseReviewSearchResult = ReturnType<typeof useReviewSearch>;
export type { ReviewSearchMatch };
