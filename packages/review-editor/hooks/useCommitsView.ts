import { useCallback, useEffect, useRef, useState } from 'react';
import type { CommitHistoryPage, CommitListEntry } from '@plannotator/shared/types';

const PAGE_SIZE = 50;
// Quiet head-compare poll cadence while the Commits view is visible. The
// commit diff itself is immutable (sha-anchored fingerprint — the staleness
// banner correctly never fires for it), so the RAIL needs its own freshness:
// an agent committing while the user walks history must show up without
// leaving and re-entering the view.
const POLL_INTERVAL_MS = 10_000;

interface UseCommitsViewOptions {
  /** Fetch only while the Commits view is visible in an API-mode session. */
  enabled: boolean;
  /** History identity — refetch from page one when it changes (worktree
   * switch, base switch). A commit CLICK must not be part of this key: paging
   * state has to survive selecting commits from a deep page. */
  contextKey: string;
  /** Full sha of the commit whose diff is on screen (null in other modes). */
  activeCommitSha: string | null;
  /** Any diff switch in flight — auto-select defers to it; the veil covers. */
  isLoadingDiff: boolean;
  /** A diff switch failed — the veil drops so the error state is visible. */
  diffError: string | null;
  /** Open a commit's diff — App's handleSelectCommit, the same path user
   * clicks take, so auto- and user-selection can never diverge. */
  onOpenCommit: (sha: string) => void;
}

interface UseCommitsViewReturn {
  commits: CommitListEntry[];
  /** Base ref the divider represents (server echo), null before first load. */
  base: string | null;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  showMore: () => void;
  /** Reload from page one (e.g. after a staleness refresh picked up new
   * commits). Keeps the current list on screen while reloading. */
  refresh: () => void;
  /** Cover the center dock while commit navigation settles: a switch in
   * flight, the log loading, or the loaded-list frame before auto-select
   * lands. Every terminal state drops it — switch error (diffError → the
   * normal error state), log error (rail shows Retry), and a genuinely empty
   * history (zero commits, nothing to select). */
  veilActive: boolean;
}

/**
 * The Commits-view session machine: pages `GET /api/commits`, keeps the rail
 * fresh (quiet poll), auto-opens HEAD once per entry, and derives the
 * center-dock veil. It all lives HERE so the invariants between the list
 * cache, the poll, the auto-select, and the veil stay locally checkable —
 * they were previously split across App.tsx, and every sync bug found in
 * review lived at that seam. Generation-guarded: a response from a
 * superseded fetch (context changed, refresh fired, poll adopted) is dropped
 * so it can't overwrite newer state.
 */
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
    // A page-1 fetch supersedes any in-flight paging request, whose
    // generation-skipped `finally` will never clear its own flag — reset it
    // here or "Show more" stays stuck disabled as "Loading…".
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
        // Append, deduping on sha — a concurrent refresh or a history that
        // moved between pages could otherwise repeat rows.
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

  // The context key the current list was loaded for. Re-entering the view
  // with the SAME key keeps the cached list (no empty flash before the
  // refetch); a DIFFERENT key (worktree/base switch while the view was away)
  // clears it first — consumers like the HEAD auto-select must never act on
  // rows that belong to another history.
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
    // On disable, invalidate in-flight fetches AND reset their loading flags:
    // a generation-skipped `finally` never clears them, which left "Show more"
    // stuck disabled as "Loading…" after leaving mid-page.
    return () => {
      generationRef.current++;
      setIsLoading(false);
      setIsLoadingMore(false);
    };
  }, [enabled, contextKey, fetchPage]);

  // Quiet freshness poll: fetch page 1 and adopt it ONLY when what the rail
  // shows would actually change — a new head (commits landed / history
  // rewritten), a moved base boundary (an agent ran `git fetch` and
  // origin/<base> advanced while HEAD stayed put), or a relabeled base. No
  // loading flags and no error-state churn — a transient network blip during
  // a background check must not disturb the rail the user is reading.
  // Adopting bumps the generation so an in-flight "Show more" from the OLD
  // history can't append its stale rows.
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
      // Boundary compared over the overlap window: the current list may be
      // paged deeper than the poll's single page, and a boundary that sits
      // beyond both is invisible to the probe (accepted micro-edge — the
      // divider that deep re-syncs on the next full reload).
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
      // Adoption invalidated any in-flight fetches, whose generation-skipped
      // `finally` blocks won't clear their own flags — and any lingering
      // error belongs to the history this just replaced.
      setIsLoading(false);
      setIsLoadingMore(false);
      setError(null);
    } catch {
      /* transient — next poll tries again */
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

  // Auto-open the HEAD commit once per entry so the center immediately
  // matches the rail. Fires once (ref-guarded): a user click, an already-
  // active commit diff, or a failed switch must not re-trigger it. Never
  // fires while any diff switch is in flight — whatever is loading already
  // owns the center; the effect re-runs when the switch settles. When entry
  // races the first log fetch, it fires as soon as the log lands.
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
