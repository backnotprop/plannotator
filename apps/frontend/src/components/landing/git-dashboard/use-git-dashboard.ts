import { useEffect, useMemo } from "react";
import { useProjectStore } from "../../../stores/project-store";
import { useGitDashboardStore, type GitDashboardPR } from "../../../stores/git-dashboard-store";

export interface PRGroups {
  open: GitDashboardPR[];
  draft: GitDashboardPR[];
  merged: GitDashboardPR[];
}

export interface DashboardMetrics {
  open: number;
  draft: number;
  merged: number;
  total: number;
}

function groupPRs(prs: GitDashboardPR[]): PRGroups {
  const open: GitDashboardPR[] = [];
  const draft: GitDashboardPR[] = [];
  const merged: GitDashboardPR[] = [];
  for (const pr of prs) {
    if (pr.state === "open" && pr.isDraft) draft.push(pr);
    else if (pr.state === "open") open.push(pr);
    else if (pr.state === "merged") merged.push(pr);
  }
  return { open, draft, merged };
}

function computeMetrics(prs: GitDashboardPR[]): DashboardMetrics {
  let open = 0;
  let draft = 0;
  let merged = 0;
  for (const pr of prs) {
    if (pr.state === "open" && pr.isDraft) draft++;
    else if (pr.state === "open") open++;
    else if (pr.state === "merged") merged++;
  }
  return { open, draft, merged, total: prs.length };
}

export function formatRelativeTime(iso: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

const STALE_MS = 30_000;

export function useGitDashboard(active = true) {
  const projects = useProjectStore((s) => s.projects);
  const prs = useGitDashboardStore((s) => s.prs);
  const loading = useGitDashboardStore((s) => s.loading);
  const error = useGitDashboardStore((s) => s.error);
  const lastFetchedAt = useGitDashboardStore((s) => s.lastFetchedAt);
  const lastProjectKey = useGitDashboardStore((s) => s.lastProjectKey);
  const fetchAllPRs = useGitDashboardStore((s) => s.fetchAllPRs);

  const clear = useGitDashboardStore((s) => s.clear);

  useEffect(() => {
    if (!active) return;
    const topLevel = projects.filter((p) => !p.parentCwd);
    if (topLevel.length === 0) {
      if (prs.length > 0) clear();
      return;
    }
    const projectKey = topLevel
      .map((p) => p.cwd)
      .sort()
      .join("|");
    const stale =
      !lastFetchedAt || Date.now() - lastFetchedAt > STALE_MS || projectKey !== lastProjectKey;
    if (stale && !loading) fetchAllPRs(projects);
  }, [active, projects, prs.length, lastFetchedAt, lastProjectKey, loading, fetchAllPRs, clear]);

  const groups = useMemo(() => groupPRs(prs), [prs]);
  const metrics = useMemo(() => computeMetrics(prs), [prs]);

  const isEmpty =
    groups.open.length === 0 && groups.draft.length === 0 && groups.merged.length === 0;

  return { groups, metrics, loading, error, isEmpty };
}
