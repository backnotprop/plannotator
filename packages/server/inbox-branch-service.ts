/**
 * Branch reviews in the Inbox server (docs/agent-guides/inbox-files-and-guides.md, "Branch reviews"): the agents' side
 * (send_message's `branch`, inbox-mcp-branch.ts), the rows Reviews lists, the PRs a report's thread owns, and the routes
 * `GET /api/inbox/reviews/branches` and `POST /api/inbox/reviews/branches/rank`. Off (config.json `inboxBranchReviews`, or Code review): no field, no rows,
 * and the routes answer `409 branch_reviews_off` before any git.
 *
 * Nothing here runs on a timer: a report is read when it arrives and judged for risk then (only with the person's
 * switch on, and only when its commit is here: a cloud agent's only when pushed to the remote it named). A judgment
 * that failed is tried once more on the next Reviews read; one lost (the Inbox restarted while it waited) or made
 * under rules since changed reads "not ranked", and the person ranks it again by hand. Branches nobody reported are
 * Reviews' "On this computer" (inbox-local-work.ts), which asks `reported` to leave a reported one to its row.
 */
import {
  inboxBranchReportOwners,
  inboxBranchRiskKey,
  type InboxBranchReport,
  type InboxBranchReportRow,
} from "@plannotator/core/inbox-branch-reports";
import { inboxGitRemoteKey } from "@plannotator/core/inbox-git-url";
import { inboxRowArchived, type InboxProject, type InboxPull, type InboxReviewStart } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { branchHeadHere, commitContains, createInboxBranchReports, offlineGitTooOld, pushedHere, readBranchDiff, readReportedBranch } from "./inbox-branch-reports";
import type { InboxBranchMcp } from "./inbox-mcp-branch";
import type { PullRisk } from "./inbox-pull-risk";

/** A head not found here is looked for again no sooner than this (a fetch may bring it). */
const UNREACHABLE_RECHECK_MS = 60_000;

export interface InboxBranchServiceOptions {
  store: InboxStore;
  dataDir: string;
  runtime: ReviewGitRuntime;
  on: () => boolean;
  risk: Pick<PullRisk, "assessBranch" | "branchJudgment" | "branchPending" | "branchRankable">;
  /** The origin a project's folder has, as the repo cache last read it (`host/owner/repo`, lowercased), never a git call. */
  originOf: (root: string) => string | null;
  /** The thread landed: a PR it owned merged (`inbox/pull-links.json`'s landings). */
  landed?: (threadId: string) => boolean;
  now?: () => number;
}

export function createInboxBranchService(options: InboxBranchServiceOptions) {
  const { store, runtime } = options;
  const now = options.now ?? Date.now;
  const reports = createInboxBranchReports(options.dataDir);
  /**
   * Whether a report's head is a commit here (and, for a cloud agent's, pushed to the remote it named), by folder and
   * commit (`reachKey`): true is kept, false is read again after a while.
   */
  const reach = new Map<string, { here: boolean; at: number }>();
  const reachKey = (kind: "here" | "pushed", folder: string | null, head: string) => `${kind}\u0000${folder ?? ""}\u0000${head}`;
  /**
   * Whether a report's head is contained in the commit a PR merged at, by folder, head and merged commit: a true or false
   * git gave is kept (commits don't change); one git couldn't answer is asked again after a while.
   */
  const contained = new Map<string, { in: boolean | null; at: number }>();
  /** A failed judgment is tried once more on a later Reviews read: by risk key and head. */
  const retried = new Set<string>();

  const rootOf = (projectId: string): string | null => store.project(projectId)?.root ?? null;
  /** Where a report's git is read: the folder it was read in when reported, else its project's. */
  const folderOf = (report: InboxBranchReport): string | null => report.folder ?? rootOf(report.project_id);

  /** Seen before within the recheck, else asked of git and kept. */
  const cached = async (key: string, ask: () => Promise<boolean>): Promise<boolean> => {
    const seen = reach.get(key);
    if (seen && (seen.here || now() - seen.at < UNREACHABLE_RECHECK_MS)) return seen.here;
    const here = await ask();
    reach.set(key, { here, at: now() });
    return here;
  };

  /** The commit is here to be judged: a cloud agent's only when a remote-tracking ref of its named remote holds it. */
  const judgeable = async (report: InboxBranchReport): Promise<boolean> => {
    const folder = folderOf(report);
    if (!folder || !report.head || !report.base) return false;
    if (report.place !== "cloud") return reachable(report);
    const head = report.head;
    return cached(reachKey("pushed", folder, head), () => pushedHere(runtime, folder, head, report.remote_url));
  };

  /**
   * Its risk, at most once per head and rules. The prompt's title is the branch's name only: the agent's summary is
   * its own words about its own work, and never steers the judgment.
   */
  const judge = async (report: InboxBranchReport): Promise<void> => {
    const root = folderOf(report);
    if (!root || !report.head || !report.base || !(await judgeable(report))) return;
    const { head, base } = report;
    options.risk.assessBranch({
      key: inboxBranchRiskKey(report.project_id, report.branch),
      head_sha: head,
      base,
      title: report.branch,
      read: () => readBranchDiff(runtime, root, base, head),
    });
  };

  const mcp: InboxBranchMcp = {
    on: options.on,
    get: (projectId, branch) => reports.get(projectId, branch),
    ofThread: (threadId) => reports.ofThread(threadId),
    landed: (threadId) => options.landed?.(threadId) === true,
    // The agent's own folder first (a worktree of the project), else the project's.
    read: async (project, field, workingFolder, readOptions) => {
      for (const folder of [workingFolder, project.root]) {
        if (!folder) continue;
        const read = await readReportedBranch(runtime, folder, field, readOptions);
        if (read.reachable || folder === project.root) return { ...read, folder };
      }
      return { ...(await readReportedBranch(runtime, null, field, readOptions)), folder: null };
    },
    projectOfRemote: (remoteUrl) => {
      const key = inboxGitRemoteKey(remoteUrl);
      if (!key) return null;
      const found = new Map<string, InboxProject>();
      for (const project of store.allProjects()) {
        if (options.originOf(project.root) !== key) continue;
        const id = store.canonicalProjectId(project.id);
        found.set(id, store.project(id) ?? project);
      }
      return found.size === 1 ? [...found.values()][0]! : null;
    },
    recorded: (report, reachable) => {
      reports.put(report);
      if (report.head) reach.set(reachKey("here", folderOf(report), report.head), { here: reachable, at: now() });
      // Risk once per reported head, never for a head this computer can't read (nor a cloud agent's unpushed one).
      if (reachable) void judge(report).catch(() => {});
    },
    canonicalId: (projectId) => store.canonicalProjectId(projectId),
  };

  /** The reports whose thread is listed and not archived: a deleted or archived thread's report has no row. */
  const listed = (): { report: InboxBranchReport; name: string | null }[] =>
    reports.list().flatMap((report) => {
      const row = store.listRow(report.thread_id);
      return row && !inboxRowArchived(row) ? [{ report, name: row.thread_name ?? row.subject }] : [];
    });

  const reachable = async (report: InboxBranchReport): Promise<boolean> => {
    const head = report.head;
    if (!head) return false;
    const folder = folderOf(report);
    return cached(reachKey("here", folder, head), () => branchHeadHere(runtime, folder, head));
  };

  /** A cloud agent's remote is a project's origin here (the repo cache, no git). */
  const remoteKnown = (remoteUrl: string | null): boolean => {
    const key = remoteUrl ? inboxGitRemoteKey(remoteUrl) : null;
    return !!key && store.allProjects().some((project) => options.originOf(project.root) === key);
  };

  /**
   * The code is here to open and review: a cloud agent's only when pushed to the remote it named (a commit that is
   * here only as local work is not what it reported), anyone else's when the commit is in the checkout.
   */
  const codeHere = (report: InboxBranchReport): Promise<boolean> => (report.place === "cloud" ? judgeable(report) : reachable(report));

  /**
   * `riskOn`: a branch may be judged now (`branchRankable`), read once per list. `retry`: the person's own Reviews read,
   * the only read that tries a failed judgment once more (never a linked machine's read of this list).
   */
  const rowOf = async (report: InboxBranchReport, riskOn: boolean, retry: boolean): Promise<InboxBranchReportRow> => {
    const key = inboxBranchRiskKey(report.project_id, report.branch);
    const { judgment, failed } = options.risk.branchJudgment(key, report.head, report.base);
    const pending = options.risk.branchPending(key, report.head, report.base);
    const canRun = !judgment && !pending && riskOn && (await judgeable(report));
    // Tried once more after a failure, on this read (no timer); after that the person ranks it by hand.
    const once = `${key}\u0000${report.head}`;
    const retrying = retry && !!failed && canRun && !retried.has(once);
    if (retrying) {
      retried.add(once);
      void judge(report).catch(() => {});
    }
    return {
      thread_id: report.thread_id,
      project_id: report.project_id,
      branch: report.branch,
      base: report.base,
      head: report.head,
      place: report.place,
      remote_url: report.remote_url,
      summary: report.summary,
      at: report.at,
      reports: report.reports,
      agent: report.agent,
      reachable: await codeHere(report),
      ...(report.place === "cloud" ? { remote_known: remoteKnown(report.remote_url) } : {}),
      // Git's version is checked once per process, not on each read.
      ...((await offlineGitTooOld(runtime)) ? { git_too_old: true as const } : {}),
      risk: judgment,
      risk_failed: failed,
      ...(canRun && !retrying && (!failed || retried.has(once)) ? { rankable: true } : {}),
    };
  };

  return {
    mcp,
    /** This computer's reported branches as rows (a linked machine's door read): never retries anything. */
    async rows(): Promise<InboxBranchReportRow[]> {
      if (!options.on()) return [];
      const riskOn = options.risk.branchRankable();
      return Promise.all(listed().map(({ report }) => rowOf(report, riskOn, false)));
    },
    /**
     * The Reviews rows' starts: a reported branch's thread is a review thread from its first report. `retry`: this is
     * the person's own Reviews read (not a linked machine's), so a failed judgment is tried once more.
     */
    async started(retry = false): Promise<Map<string, InboxReviewStart>> {
      const out = new Map<string, InboxReviewStart>();
      if (!options.on()) return out;
      const riskOn = options.risk.branchRankable();
      for (const { report, name } of listed()) {
        out.set(report.thread_id, {
          kind: "branch",
          changes: "branch",
          branch: report.branch,
          base: report.base,
          ask: "guide",
          host: report.agent?.host ?? "",
          project_id: report.project_id,
          at: report.at,
          name,
          report: await rowOf(report, riskOn, retry),
        });
      }
      return out;
    },
    /** The PRs the reported branches' threads own (the person's own PR on that branch): one thread from report to PR. */
    async owners(pulls: readonly InboxPull[], projectsByRepo: ReadonlyMap<string, readonly string[]>): Promise<Map<string, { thread_id: string }>> {
      if (!options.on()) return new Map();
      const listedReports = listed().map(({ report }) => report);
      const fullOf = (report: Pick<InboxBranchReport, "project_id" | "branch">) =>
        listedReports.find((one) => one.project_id === report.project_id && one.branch === report.branch);
      const keyOf = (report: Pick<InboxBranchReport, "project_id" | "branch" | "head">, merged: string): string => {
        const full = fullOf(report);
        return `${full ? (folderOf(full) ?? "") : ""}\u0000${report.head ?? ""}\u0000${merged}`;
      };
      // First pass: the PRs that merged at a known commit other than the reported one, whose answer git must give.
      const asks = new Map<string, { folder: string | null; head: string; merged: string }>();
      inboxBranchReportOwners(listedReports, pulls, projectsByRepo, (report, merged) => {
        const key = keyOf(report, merged);
        const seen = contained.get(key);
        const full = fullOf(report);
        if (full && report.head && (!seen || (seen.in === null && now() - seen.at >= UNREACHABLE_RECHECK_MS))) {
          asks.set(key, { folder: folderOf(full), head: report.head, merged });
        }
        return false;
      });
      await Promise.all(
        [...asks].map(async ([key, ask]) => {
          contained.set(key, { in: await commitContains(runtime, ask.folder, ask.head, ask.merged), at: now() });
        }),
      );
      return inboxBranchReportOwners(listedReports, pulls, projectsByRepo, (report, merged) => contained.get(keyOf(report, merged))?.in === true);
    },
    /**
     * Rank a reported branch now, by hand (its Rank action): the one way, beside its report, a branch is judged. Only
     * when it can be (risk on, its commit here, no judgment kept or under way at this head and rules). False: nothing
     * was started.
     */
    async rank(threadId: string): Promise<boolean> {
      if (!options.on()) return false;
      const report = reports.ofThread(threadId);
      if (!report) return false;
      const key = inboxBranchRiskKey(report.project_id, report.branch);
      if (options.risk.branchJudgment(key, report.head, report.base).judgment || options.risk.branchPending(key, report.head, report.base) || !options.risk.branchRankable()) return false;
      if (!(await judgeable(report))) return false;
      await judge(report);
      return options.risk.branchPending(key, report.head, report.base);
    },
    /** A branch an agent reported in this project (Reviews' "On this computer" leaves it to its thread's row). */
    reported(projectId: string, branch: string): boolean {
      return reports.get(store.canonicalProjectId(projectId), branch) !== null;
    },
  };
}

export type InboxBranchService = ReturnType<typeof createInboxBranchService>;
