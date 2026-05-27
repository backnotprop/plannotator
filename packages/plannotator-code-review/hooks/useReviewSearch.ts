import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  groupReviewSearchMatches,
  buildSearchIndex,
  findMatchesInIndex,
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
  activeFilePath: string | null;
  onRevealMatch?: (match: ReviewSearchMatch) => void;
}

export function useReviewSearch({
  files,
  activeFilePath,
  onRevealMatch,
}: UseReviewSearchOptions) {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeSearchMatchId, setActiveSearchMatchId] = useState(null as string | null);

  const searchInputRef = useRef(null as HTMLInputElement | null);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedSearchQuery('');
      return;
    }
    const timeoutId = setTimeout(() => setDebouncedSearchQuery(searchQuery), 200);
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  const isSearchPending = searchQuery.trim() !== ''
    && searchQuery.trim().toLowerCase() !== debouncedSearchQuery.trim().toLowerCase();

  const searchIndex = useMemo(() => buildSearchIndex(files), [files]);

  const searchMatches = useMemo(() => {
    return findMatchesInIndex(searchIndex, debouncedSearchQuery);
  }, [searchIndex, debouncedSearchQuery]);

  const searchGroups = useMemo(() => {
    return groupReviewSearchMatches(files, searchMatches);
  }, [files, searchMatches]);

  const activeSearchMatch = useMemo(() => {
    if (!activeSearchMatchId) return null;
    return searchMatches.find(match => match.id === activeSearchMatchId) ?? null;
  }, [searchMatches, activeSearchMatchId]);

  const activeFileSearchMatches = useMemo(() => {
    if (!activeFilePath) return [];
    return searchMatches.filter(match => match.filePath === activeFilePath);
  }, [activeFilePath, searchMatches]);

  const openSearch = useCallback(() => {
    setIsSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const closeSearch = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setDebouncedSearchQuery('');
    setActiveSearchMatchId(null);
    setIsSearchOpen(false);
  }, []);

  const handleSearchInputChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (value.trim()) {
      setIsSearchOpen(true);
    }
  }, []);

  const activateSearchMatch = useCallback((match: ReviewSearchMatch | null) => {
    setActiveSearchMatchId(match?.id ?? null);
    if (match) {
      onRevealMatch?.(match);
    }
  }, [onRevealMatch]);

  const handleSelectSearchMatch = useCallback((matchId: string) => {
    const match = searchMatches.find(candidate => candidate.id === matchId) ?? null;
    activateSearchMatch(match);
  }, [searchMatches, activateSearchMatch]);

  const stepSearchMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;

    const currentIndex = activeSearchMatchId
      ? searchMatches.findIndex(match => match.id === activeSearchMatchId)
      : -1;
    const nextIndex = getWrappedMatchIndex(searchMatches.length, currentIndex, direction);
    const nextMatch = nextIndex === -1 ? null : (searchMatches[nextIndex] ?? null);
    activateSearchMatch(nextMatch);
  }, [searchMatches, activeSearchMatchId, activateSearchMatch]);

  useEffect(() => {
    if (!debouncedSearchQuery.trim() || searchMatches.length === 0) {
      setActiveSearchMatchId(null);
      return;
    }

    const stillExists = activeSearchMatchId != null
      && searchMatches.some(match => match.id === activeSearchMatchId);

    if (!stillExists) {
      activateSearchMatch(searchMatches[0]);
    }
  }, [debouncedSearchQuery, searchMatches, activeSearchMatchId, activateSearchMatch]);

  return {
    searchQuery,
    debouncedSearchQuery,
    isSearchPending,
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
