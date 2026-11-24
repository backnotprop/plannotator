/**
 * Ship's watch reads one pull request (core `InboxShipRead`) with the person's `gh`, as the Reviews list reads it:
 * one GraphQL call for its state, head, review decision, mergeability, the head commit's checks by name, and its
 * comments. GitHub only in this slice; a GitLab merge request reads null (its reader follows).
 */
import type { InboxShipRead } from "@plannotator/core/inbox-ship";
import type { RefRunner } from "@plannotator/shared/ref-cards";

export const SHIP_PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft mergedAt headRefOid baseRefName reviewDecision mergeable mergeStateStatus
      latestReviews(last: 20) { nodes { state author { login } } }
      comments(last: 30) { nodes { id createdAt author { login } } }
      reviewThreads(last: 30) { nodes { comments(last: 1) { nodes { id createdAt author { login } } } } }
      commits(last: 1) { nodes { commit { author { user { login } } statusCheckRollup { state contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion status }
        ... on StatusContext { context state }
      } } } } } }
    }
  }
}`;

const FAILED_RUN = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const FAILED_STATUS = new Set(["FAILURE", "ERROR"]);

type Node = { __typename?: string; name?: string; conclusion?: string | null; status?: string; context?: string; state?: string };

/** The answer of `SHIP_PULL_QUERY` as the watch reads it; null when it is not one. */
export function parseShipPull(stdout: string): InboxShipRead | null {
  let pr: Record<string, unknown> | null = null;
  let me: string | null = null;
  try {
    const data = (JSON.parse(stdout) as { data?: { viewer?: { login?: string }; repository?: { pullRequest?: Record<string, unknown> | null } } }).data;
    pr = data?.repository?.pullRequest ?? null;
    me = data?.viewer?.login ?? null;
  } catch {
    return null;
  }
  if (!pr) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const commit = ((pr.commits as { nodes?: { commit?: { author?: { user?: { login?: string } | null } | null; statusCheckRollup?: { state?: string; contexts?: { nodes?: Node[] } } | null } }[] })?.nodes ?? [])[0]?.commit;
  const rollup = commit?.statusCheckRollup ?? null;
  const nodes = rollup?.contexts?.nodes ?? [];
  const failing = [
    ...new Set(
      nodes
        .filter((n) => (n.__typename === "StatusContext" ? FAILED_STATUS.has(n.state ?? "") : FAILED_RUN.has(n.conclusion ?? "")))
        .map((n) => (n.__typename === "StatusContext" ? n.context : n.name) ?? "")
        .filter(Boolean),
    ),
  ];
  const checks = !rollup ? null : rollup.state === "SUCCESS" ? "success" : rollup.state === "FAILURE" || rollup.state === "ERROR" ? "failure" : "pending";
  const decision = pr.reviewDecision;
  const review = decision === "APPROVED" ? "approved" : decision === "CHANGES_REQUESTED" ? "changes_requested" : decision === "REVIEW_REQUIRED" ? "review_required" : null;
  const reviews = ((pr.latestReviews as { nodes?: { state?: string; author?: { login?: string } | null }[] })?.nodes ?? []).filter((r) => r.state === "CHANGES_REQUESTED");
  type Comment = { id?: string; createdAt?: string; author?: { login?: string } | null };
  const issue = (pr.comments as { nodes?: Comment[] } | undefined)?.nodes ?? [];
  const code = ((pr.reviewThreads as { nodes?: { comments?: { nodes?: Comment[] } }[] } | undefined)?.nodes ?? []).flatMap((t) => t.comments?.nodes ?? []);
  // The newest comment by someone else: the agent answers as the person, and its own answers never wake it.
  const newest = [...issue, ...code]
    .filter((c) => typeof c.id === "string" && c.author?.login !== me)
    .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1))[0];
  return {
    state,
    head_sha: text(pr.headRefOid),
    head_mine: !!me && commit?.author?.user?.login === me,
    base: text(pr.baseRefName) ?? "the base branch",
    checks,
    failing,
    review,
    reviewer: text(reviews[reviews.length - 1]?.author?.login),
    conflicts: pr.mergeable === "CONFLICTING",
    behind: pr.mergeStateStatus === "BEHIND",
    comment: newest?.id ?? null,
    commenter: text(newest?.author?.login),
    merged_at: text(pr.mergedAt),
  };
}

/** One read of a GitHub pull request for the watch; null when it could not be read (the next tick tries again). */
export async function readShipPull(run: RefRunner, ref: { host: string; repo: string; number: number; platform?: string }): Promise<InboxShipRead | null> {
  if (ref.platform === "gitlab") return null;
  const [owner, name] = ref.repo.split("/");
  if (!owner || !name) return null;
  const result = await run("gh", ["api", "graphql", "--hostname", ref.host, "-f", `query=${SHIP_PULL_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${ref.number}`]).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return parseShipPull(result.stdout);
}
