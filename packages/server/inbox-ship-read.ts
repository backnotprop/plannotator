/**
 * Ship's watch reads one pull request (core `InboxShipRead`) the way the Reviews list reads its forge:
 *
 * - GitHub: one `gh api graphql` call for its state, head, review decision, mergeability, the head commit's checks by
 *   name, and its comments (`readShipPull`).
 * - GitLab: the Reviews list's own read of the merge request (`shipReadOfPull`, from the list's `InboxPull`): its
 *   state, head, pipeline, approvals and conflicts. GitLab's list does not name failed jobs or comments, so a failed
 *   pipeline is named "pipeline" and comments do not wake the agent there.
 *
 * Any other forge has no reader in the Inbox, so it is never offered Ship (core `shipForge`).
 *
 * A read that fails says why in a few words (`{ failed }`): the watch counts them and shows Stuck after a few in a row.
 */
import { shipPlatform, type InboxShip, type InboxShipRead } from "@plannotator/core/inbox-pull-handoff";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { refErrorOf, type RefCli, type RefCommandResult, type RefRunner } from "@plannotator/shared/ref-cards";

export type InboxShipReadResult = InboxShipRead | { failed: string };

export const SHIP_PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state isDraft mergedAt headRefOid baseRefName reviewDecision mergeable mergeStateStatus
      latestReviews(last: 20) { nodes { state author { login } } }
      comments(last: 30) { nodes { id createdAt author { login } } }
      reviewThreads(last: 30) { nodes { comments(last: 5) { nodes { id createdAt author { login } } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 100) { nodes {
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
  let viewer: unknown = null;
  try {
    const data = (JSON.parse(stdout) as { data?: { viewer?: { login?: unknown } | null; repository?: { pullRequest?: Record<string, unknown> | null } } }).data;
    pr = data?.repository?.pullRequest ?? null;
    viewer = data?.viewer?.login ?? null;
  } catch {
    return null;
  }
  if (!pr) return null;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const commit = ((pr.commits as { nodes?: { commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: Node[] } } | null } }[] })?.nodes ?? [])[0]?.commit;
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
  // Every comment read, oldest first, with its author: the watch tells which are news to the agent (core
  // `shipNewComments`): one by the signed-in login (`viewer`) may be the agent's own.
  const comments = [...issue, ...code]
    .filter((c): c is Comment & { id: string } => typeof c.id === "string" && c.id.length > 0)
    .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : (a.createdAt ?? "") > (b.createdAt ?? "") ? 1 : 0))
    .map((c) => ({ id: c.id, by: text(c.author?.login) }));
  return {
    state,
    head_sha: text(pr.headRefOid),
    base: text(pr.baseRefName) ?? "the base branch",
    checks,
    failing,
    review,
    reviewer: text(reviews[reviews.length - 1]?.author?.login),
    conflicts: pr.mergeable === "CONFLICTING",
    behind: pr.mergeStateStatus === "BEHIND",
    comments,
    viewer: text(viewer),
    merged_at: text(pr.mergedAt),
  };
}

/** Why a CLI's answer is no read, in a few plain words for the ship log. */
export function shipReadFailure(cli: RefCli, host: string, result: RefCommandResult | null): string {
  if (!result) return `${cli} didn't run`;
  if (result.timedOut) return `${cli} timed out`;
  const kind = refErrorOf(cli, result);
  if (kind === "cli_missing") return `${cli} isn't installed`;
  if (kind === "signed_out") return `${cli} isn't signed in to ${host}`;
  if (kind === "rate_limited") return `${host} is rate limiting ${cli}`;
  if (kind === "refused") return `${host} refused ${cli}`;
  const line = `${result.stderr}`.split("\n").map((l) => l.trim()).find(Boolean);
  return line ? `${cli}: ${line.slice(0, 120)}` : `${cli} failed`;
}

/** One read of a GitHub pull request for the watch; `{ failed }` with why when it could not be read. */
export async function readShipPull(run: RefRunner, ref: { host: string; repo: string; number: number }): Promise<InboxShipReadResult> {
  const [owner, name] = ref.repo.split("/");
  if (!owner || !name) return { failed: "not a GitHub repository" };
  const result = await run("gh", ["api", "graphql", "--hostname", ref.host, "-f", `query=${SHIP_PULL_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${ref.number}`]).catch(() => null);
  if (!result || result.exitCode !== 0) return { failed: shipReadFailure("gh", ref.host, result) };
  return parseShipPull(result.stdout) ?? { failed: `${ref.host} answered without the pull request` };
}

/**
 * The watch's read of a ship, by its forge (core `shipPlatform`): GitHub with `gh` (`readShipPull`), GitLab through the
 * Reviews list's own read of the merge request (`listed`: the list's pull, else why it has none).
 */
export function createShipReader(deps: { run: RefRunner; listed: (ship: InboxShip) => Promise<InboxPull | { failed: string }> }) {
  return async (ship: InboxShip): Promise<InboxShipReadResult> => {
    if (shipPlatform(ship) !== "gitlab") return readShipPull(deps.run, ship);
    const pull = await deps.listed(ship).catch((): { failed: string } => ({ failed: "glab didn't run" }));
    return "failed" in pull ? pull : shipReadOfPull(pull);
  };
}

/**
 * A merge request as the Reviews list read it (GitLab), as the watch reads it. The list says the pipeline's state but
 * not its jobs: a failed one is named "pipeline". It says no comments, so none wakes the agent there.
 */
export function shipReadOfPull(pull: Pick<InboxPull, "state" | "head_sha" | "base" | "checks" | "review" | "conflicts" | "merged_at">): InboxShipRead {
  return {
    state: pull.state,
    head_sha: pull.head_sha ?? null,
    base: pull.base || "the base branch",
    checks: pull.checks,
    failing: pull.checks === "failure" ? ["pipeline"] : [],
    review: pull.review,
    reviewer: null,
    conflicts: pull.conflicts === true,
    behind: false,
    comments: [],
    viewer: null,
    merged_at: pull.merged_at,
  };
}
