import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  computePlanDiff,
  type PlanDiffBlock,
  type PlanDiffStats,
} from "../utils/planDiffEngine";

export interface VersionInfo {
  version: number;
  totalVersions: number;
  project: string;
}

export interface VersionEntry {
  version: number;
  timestamp: string;
}

export interface UsePlanDiffReturn {
  diffBaseVersion: number | null;
  diffBasePlan: string | null;
  diffBlocks: PlanDiffBlock[] | null;
  diffStats: PlanDiffStats | null;
  hasPreviousVersion: boolean;
  selectBaseVersion: (version: number) => Promise<void>;
  versions: VersionEntry[];
  isLoadingVersions: boolean;
  isSelectingVersion: boolean;
  fetchingVersion: number | null;
  fetchVersions: () => Promise<void>;
}

export interface PlanDiffFetchers {
  fetchVersion?: (version: number) => Promise<{ plan: string; version: number }>;
  fetchVersions?: () => Promise<{
    project: string;
    slug: string;
    versions: VersionEntry[];
  }>;
}

const defaultFetchVersion = async (
  version: number
): Promise<{ plan: string; version: number }> => {
  const res = await fetch(`/api/plan/version?v=${version}`);
  if (!res.ok) {
    throw new Error(`Failed to load version ${version}.`);
  }
  return (await res.json()) as { plan: string; version: number };
};

const defaultFetchVersions = async (): Promise<{
  project: string;
  slug: string;
  versions: VersionEntry[];
}> => {
  const res = await fetch("/api/plan/versions");
  if (!res.ok) {
    throw new Error("Failed to load versions.");
  }
  return (await res.json()) as {
    project: string;
    slug: string;
    versions: VersionEntry[];
  };
};

export function usePlanDiff(
  currentPlan: string,
  initialPreviousPlan: string | null,
  versionInfo: VersionInfo | null,
  fetchers?: PlanDiffFetchers,
  /**
   * Omit (or keep it referentially stable, as the root document does for the life of a session)
   * to preserve exactly today's one-time-hydration behavior via the two sync effects below.
   */
  docKey?: string | null
): UsePlanDiffReturn {
  const fetchVersionImpl = fetchers?.fetchVersion ?? defaultFetchVersion;
  const fetchVersionsImpl = fetchers?.fetchVersions ?? defaultFetchVersions;
  const [diffBasePlan, setDiffBasePlan] = useState<string | null>(
    initialPreviousPlan
  );
  const [diffBaseVersion, setDiffBaseVersion] = useState<number | null>(
    versionInfo && versionInfo.version > 1 ? versionInfo.version - 1 : null
  );
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [isLoadingVersions, setIsLoadingVersions] = useState(false);
  const [isSelectingVersion, setIsSelectingVersion] = useState(false);
  const [fetchingVersion, setFetchingVersion] = useState<number | null>(null);

  useEffect(() => {
    if (initialPreviousPlan && !diffBasePlan) {
      setDiffBasePlan(initialPreviousPlan);
    }
  }, [initialPreviousPlan]);

  useEffect(() => {
    if (versionInfo && versionInfo.version > 1 && diffBaseVersion === null) {
      setDiffBaseVersion(versionInfo.version - 1);
    }
  }, [versionInfo]);

  // A plain ref (not state) since writing it must never itself trigger a render — it's only
  // read/written from inside the docKey-change effect below.
  const baseSelectionsByDocKeyRef = useRef(
    new Map<
      string | null | undefined,
      { diffBasePlan: string | null; diffBaseVersion: number | null }
    >()
  );

  const prevDocKeyRef = useRef(docKey);
  useEffect(() => {
    if (prevDocKeyRef.current === docKey) return;

    baseSelectionsByDocKeyRef.current.set(prevDocKeyRef.current, {
      diffBasePlan,
      diffBaseVersion,
    });
    prevDocKeyRef.current = docKey;

    const remembered = baseSelectionsByDocKeyRef.current.get(docKey);
    if (remembered) {
      setDiffBasePlan(remembered.diffBasePlan);
      setDiffBaseVersion(remembered.diffBaseVersion);
    } else {
      setDiffBasePlan(initialPreviousPlan);
      setDiffBaseVersion(
        versionInfo && versionInfo.version > 1 ? versionInfo.version - 1 : null
      );
    }
    setVersions([]);
    setIsLoadingVersions(false);
    setIsSelectingVersion(false);
    setFetchingVersion(null);
    // Only the identity change (docKey) should trigger this reset — the sync
    // effects above already handle initialPreviousPlan/versionInfo arriving
    // late for a stable identity, and re-running this on every value change
    // would fight version selection (selectBaseVersion intentionally leaves
    // docKey unchanged while it swaps diffBasePlan/diffBaseVersion).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  const hasPreviousVersion =
    versionInfo !== null && versionInfo.totalVersions > 1 && diffBasePlan !== null;

  const diffResult = useMemo(() => {
    if (!diffBasePlan) return null;
    return computePlanDiff(diffBasePlan, currentPlan);
  }, [currentPlan, diffBasePlan]);

  const diffBlocks = diffResult?.blocks ?? null;
  const diffStats = diffResult?.stats ?? null;

  const selectBaseVersion = useCallback(
    async (version: number) => {
      setIsSelectingVersion(true);
      setFetchingVersion(version);
      try {
        const data = await fetchVersionImpl(version);
        setDiffBasePlan(data.plan);
        setDiffBaseVersion(version);
      } catch {
        alert(`Failed to load version ${version}.`);
      } finally {
        setIsSelectingVersion(false);
        setFetchingVersion(null);
      }
    },
    [fetchVersionImpl]
  );

  const fetchVersions = useCallback(async () => {
    setIsLoadingVersions(true);
    try {
      const data = await fetchVersionsImpl();
      setVersions(data.versions);
    } catch {
    } finally {
      setIsLoadingVersions(false);
    }
  }, [fetchVersionsImpl]);

  return {
    diffBaseVersion,
    diffBasePlan,
    diffBlocks,
    diffStats,
    hasPreviousVersion,
    selectBaseVersion,
    versions,
    isLoadingVersions,
    isSelectingVersion,
    fetchingVersion,
    fetchVersions,
  };
}
