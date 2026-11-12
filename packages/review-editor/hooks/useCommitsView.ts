import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitHistoryPage, CommitListEntry } from '@plannotator/shared/types';

const PAGE_SIZE = 50;
const POLL_INTERVAL_MS = 10_000;

interface UseCommitsViewOptions {
  enabled: boolean;
  contextKey: string;
  activeCommitSha: string | null;
  isLoadingDiff: boolean;
  diffError: string | null;
  onOpenCommit: (sha: string) => void;
}

interface UseCommitsViewReturn {
  commits: CommitListEntry[];
  base: string | null;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  showMore: () => void;
  refresh: () => void;
  veilActive: boolean;
}

export function useCommitsView({
  enabled,
  contextKey,
  activeCommitSha,
  isLoadingDiff,
  diffError,
  onOpenCommit,
}: UseCommitsViewOptions): UseCommitsViewReturn {
  const [commits, setCommits] = useState<CommitListEntry[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const commitsRef = useRef(commits);
  commitsRef.current = commits;
  const baseRef = useRef(base);
  baseRef.current = base;

  const fetchPage = useCallback(async (before?: string) => {
    const generation = ++generationRef.current;
    const setBusy = before ? setIsLoadingMore : setIsLoading;
    setBusy(true);
    if (!before) setIsLoadingMore(false);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (before) params.set('before', before);
      const res = await fetch(`/api/commits?${params}`);
      const data = (await res.json()) as CommitHistoryPage & { error?: string };
      if (generation !== generationRef.current) return;
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to load commits');
      setCommits((prev) => {
        if (!before) return data.commits;
        const seen = new Set(prev.map((c) => c.sha));
        return [...prev, ...data.commits.filter((c) => !seen.has(c.sha))];
      });
      setBase(data.base || null);
      setHasMore(data.hasMore);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(err instanceof Error ? err.message : 'Failed to load commits');
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  }, []);

  const loadedContextKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (loadedContextKeyRef.current !== contextKey) {
      loadedContextKeyRef.current = contextKey;
      setCommits([]);
      setBase(null);
      setHasMore(false);
    }
    void fetchPage();
    return () => {
      generationRef.current++;
      setIsLoading(false);
      setIsLoadingMore(false);
    };
  }, [enabled, contextKey, fetchPage]);

  const checkForNewCommits = useCallback(async () => {
    const generation = generationRef.current;
    try {
      const res = await fetch(`/api/commits?limit=${PAGE_SIZE}`);
      if (!res.ok) return;
      const data = (await res.json()) as CommitHistoryPage & { error?: string };
      if (data.error) return;
      if (generation !== generationRef.current) return;
      const current = commitsRef.current;
      const sameHead = data.commits[0]?.sha === current[0]?.sha;
      const window = Math.min(data.commits.length, current.length);
      const boundaryIn = (list: readonly CommitListEntry[]): number => {
        for (let i = 0; i < window; i++) if (list[i].isPastBase) return i;
        return -1;
      };
      const sameBoundary = boundaryIn(data.commits) === boundaryIn(current);
      const sameBase = (data.base || null) === baseRef.current;
      if (sameHead && sameBoundary && sameBase) return;
      generationRef.current++;
      setCommits(data.commits);
      setBase(data.base || null);
      setHasMore(data.hasMore);
      setIsLoading(false);
      setIsLoadingMore(false);
      setError(null);
    } catch {
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      void checkForNewCommits();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, checkForNewCommits]);

  const showMore = useCallback(() => {
    const last = commitsRef.current[commitsRef.current.length - 1];
    if (last) void fetchPage(last.sha);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    void fetchPage();
  }, [fetchPage]);

  const autoSelectDone = useRef(false);
  useEffect(() => {
    if (!enabled) {
      autoSelectDone.current = false;
      return;
    }
    if (autoSelectDone.current) return;
    if (activeCommitSha) {
      autoSelectDone.current = true;
      return;
    }
    if (isLoadingDiff) return;
    const head = commits.find((c) => c.isHead) ?? commits[0];
    if (!head) return;
    autoSelectDone.current = true;
    onOpenCommit(head.sha);
  }, [enabled, activeCommitSha, isLoadingDiff, commits, onOpenCommit]);

  const veilActive =
    enabled && !diffError && !error &&
    (isLoadingDiff || (!activeCommitSha && (isLoading || commits.length > 0)));

  return { commits, base, hasMore, isLoading, isLoadingMore, error, showMore, refresh, veilActive };
}
