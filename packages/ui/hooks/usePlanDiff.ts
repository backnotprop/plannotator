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

export interface ProjectPlan {
  slug: string;
  versions: number;
  lastModified: string;
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
  /** All plans in the project */
  projectPlans: ProjectPlan[];
  /** Whether version list is loading */
  isLoadingVersions: boolean;
  /** Whether a version selection fetch is in progress */
  isSelectingVersion: boolean;
  /** Which version is currently being fetched (null if none) */
  fetchingVersion: number | null;
  /** Fetch the version list for the sidebar */
  fetchVersions: () => Promise<void>;
  /** Fetch the project plan list for the sidebar */
  fetchProjectPlans: () => Promise<void>;
}

export function usePlanDiff(
  currentPlan: string,
  initialPreviousPlan: string | null,
  versionInfo: VersionInfo | null
): UsePlanDiffReturn {
  const [diffBasePlan, setDiffBasePlan] = useState<string | null>(
    initialPreviousPlan
  );
  const [diffBaseVersion, setDiffBaseVersion] = useState<number | null>(
    versionInfo && versionInfo.version > 1 ? versionInfo.version - 1 : null
  );
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [projectPlans, setProjectPlans] = useState<ProjectPlan[]>([]);
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
        const res = await fetch(`/api/plan/version?v=${version}`);
        if (!res.ok) {
          alert(`Failed to load version ${version}.`);
          return;
        }
        const data = (await res.json()) as { plan: string; version: number };
        setDiffBasePlan(data.plan);
        setDiffBaseVersion(version);
      } catch {
        alert(`Failed to load version ${version}.`);
      } finally {
        setIsSelectingVersion(false);
        setFetchingVersion(null);
      }
    },
    []
  );

  const fetchVersions = useCallback(async () => {
    setIsLoadingVersions(true);
    try {
      const res = await fetch("/api/plan/versions");
      if (!res.ok) return;
      const data = (await res.json()) as {
        project: string;
        slug: string;
        versions: VersionEntry[];
      };
      setVersions(data.versions);
    } catch {
      // Failed to fetch versions
    } finally {
      setIsLoadingVersions(false);
    }
  }, []);

  const fetchProjectPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/plan/history");
      if (!res.ok) return;
      const data = (await res.json()) as {
        project: string;
        plans: ProjectPlan[];
      };
      setProjectPlans(data.plans);
    } catch {
      // Failed to fetch project plans
    }
  }, []);

  return {
    diffBaseVersion,
    diffBasePlan,
    diffBlocks,
    diffStats,
    hasPreviousVersion,
    selectBaseVersion,
    versions,
    projectPlans,
    isLoadingVersions,
    isSelectingVersion,
    fetchingVersion,
    fetchVersions,
    fetchProjectPlans,
  };
}
