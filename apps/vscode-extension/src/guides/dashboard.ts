/**
 * The dashboard's data (SPEC 3.1): this repo's local changes and open PRs,
 * recent guides from the shared guide store, and PRs waiting on the user.
 * Stacks and other repositories are phase 2. Pure apart from the injected
 * runner, so tests script `git` and `gh`.
 */

import { getRepoInfo, summarizeLocalChanges, type LocalChangesSummary, type RepoInfo } from "./sources/git";
import { ghStatus, listRepoPullRequests, listReviewRequested, type GhStatus, type PullRequestRow, type WaitingRow } from "./sources/github";
import type { Runner } from "./sources/runner";
import { listRecent, listRecentEverywhere, type RecentEntry } from "./store";

export type DashboardGh = GhStatus | { state: "not-github" };

export interface DashboardModel {
  repo: RepoInfo | null;
  local: LocalChangesSummary | null;
  gh: DashboardGh;
  prs: PullRequestRow[];
  /** The open PR whose head branch is the current branch. */
  currentBranchPR: PullRequestRow | null;
  waiting: WaitingRow[];
  recent: RecentEntry[];
  /** Problems worth one line each (a `gh` failure, …). */
  notes: string[];
  loadedAt: number;
}

export interface DashboardOptions {
  prLimit?: number;
  waitingLimit?: number;
  recentLimit?: number;
  now?: () => number;
}

export async function loadDashboard(runner: Runner, cwd: string | undefined, options: DashboardOptions = {}): Promise<DashboardModel> {
  const now = options.now ?? Date.now;
  const notes: string[] = [];
  const repo = cwd ? await getRepoInfo(runner, cwd) : null;
  const [local, gh] = await Promise.all([
    repo ? summarizeLocalChanges(runner, repo).catch(() => null) : Promise.resolve(null),
    ghStatus(runner, repo?.root),
  ]);
  let prs: PullRequestRow[] = [];
  let waiting: WaitingRow[] = [];
  let ghState: DashboardGh = gh;
  if (gh.state === "ok") {
    const [prResult, waitingResult] = await Promise.allSettled([
      repo?.github ? listRepoPullRequests(runner, repo.root, gh.user, options.prLimit ?? 30) : Promise.resolve([]),
      listReviewRequested(runner, options.waitingLimit ?? 15),
    ]);
    if (prResult.status === "fulfilled") prs = prResult.value;
    else notes.push(`Could not list pull requests: ${firstLine(prResult.reason)}`);
    if (waitingResult.status === "fulfilled") waiting = waitingResult.value;
    else notes.push(`Could not list PRs waiting on you: ${firstLine(waitingResult.reason)}`);
    if (repo && !repo.github) ghState = { state: "not-github" };
  }
  const headByPR = new Map(prs.map((p) => [p.number, p.headRefOid]));
  // No folder open: the recent guides of every repository on this machine.
  const recent = repo ? listRecent(repo.repoKey, { headForPR: (n) => headByPR.get(n) || undefined, limit: options.recentLimit ?? 12 }) : listRecentEverywhere({ limit: options.recentLimit ?? 12 });
  const currentBranchPR = repo ? prs.find((p) => p.headRefName === repo.branch) ?? null : null;
  return { repo, local, gh: ghState, prs, currentBranchPR, waiting, recent, notes, loadedAt: now() };
}

function firstLine(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : String(reason);
  return text.split("\n")[0].slice(0, 200);
}
