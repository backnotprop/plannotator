/**
 * Plan Diff Hook
 *
 * Manages plan diff state: version fetching, diff computation, and version browsing.
 * Consumes the version history API endpoints.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
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
  /** The version we're comparing against */
  diffBaseVersion: number | null;
  /** Content of the base version */
  diffBasePlan: string | null;
  /** Computed diff blocks (null if no base plan to diff against) */
  diffBlocks: PlanDiffBlock[] | null;
  /** Computed diff stats (null if no diff) */
  diffStats: PlanDiffStats | null;
  /** Whether a previous version exists to diff against */
  hasPreviousVersion: boolean;
  /** Change the base version to diff against */
  selectBaseVersion: (version: number) => Promise<void>;
  /** All versions of the current plan */
  versions: VersionEntry[];
  /** Whether version list is loading */
  isLoadingVersions: boolean;
  /** Whether a version selection fetch is in progress */
  isSelectingVersion: boolean;
  /** Which version is currently being fetched (null if none) */
  fetchingVersion: number | null;
  /** Fetch the version list for the sidebar */
  fetchVersions: () => Promise<void>;
}

export interface PlanDiffFetchers {
  /** Fetch a specific version's plan content. Default → GET /api/plan/version?v=N */
  fetchVersion?: (version: number) => Promise<{ plan: string; version: number }>;
  /** Fetch the version list. Default → GET /api/plan/versions */
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
  fetchers?: PlanDiffFetchers
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

  // Sync diffBasePlan when initialPreviousPlan arrives after mount (API response)
  useEffect(() => {
    if (initialPreviousPlan && !diffBasePlan) {
      setDiffBasePlan(initialPreviousPlan);
    }
  }, [initialPreviousPlan]);

  // Sync diffBaseVersion when versionInfo arrives after mount
  useEffect(() => {
    if (versionInfo && versionInfo.version > 1 && diffBaseVersion === null) {
      setDiffBaseVersion(versionInfo.version - 1);
    }
  }, [versionInfo]);

  const hasPreviousVersion =
    versionInfo !== null && versionInfo.totalVersions > 1 && diffBasePlan !== null;

  // Compute diff whenever currentPlan or diffBasePlan changes
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
      // Failed to fetch versions
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
