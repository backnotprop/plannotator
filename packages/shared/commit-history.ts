/**
 * Commit-history rail — backs GET /api/commits and the commitInfo sidecar.
 *
 * Runtime-agnostic like review-core (Pi consumes a build-time copy via
 * vendor.sh). Deliberately separate from review-core: nothing here
 * participates in the diff-type dispatch — it is the Commits panel's data
 * layer (linear --first-parent pages + one commit's full metadata). The
 * commit:<sha> DIFF plumbing (parseCommitDiffType, the runGitDiff /
 * fingerprint / file-contents cases) stays in review-core with the other
 * diff types.
 */

import {
  BARE_HEX_SHA_RE,
  COMMIT_FIELD_SEP,
  splitCommitFormatFields,
  type ReviewGitRuntime,
} from "./review-core";

// --- Commit history rail ------------------------------------------------------
//
// Backs GET /api/commits: the Commits panel's linear `--first-parent` walk from
// HEAD, newest first. Paged (before = the previous page's last sha), with a
// per-commit "past the base" flag so the client can draw the divider where the
// branch meets the resolved base.

export interface CommitListEntry {
  /** Full SHA — sent back as `commit:<sha>` on click. */
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** Author email — the key the avatar resolver matches on. */
  authorEmail: string;
  /** Committer time, epoch milliseconds. Clients format it themselves —
   * git's `%cr` relative strings are locale-dependent (gettext), so a
   * pre-formatted string couldn't be compacted reliably. */
  committedAt: number;
  isHead: boolean;
  /** True once the walk is at/below the base (reachable from it) — everything
   * above the first past-base commit is branch-local work. */
  isPastBase: boolean;
  /** Author profile image, when the forge could resolve one (server-enriched
   * via commit-avatars; absent → the client renders an initials fallback). */
  avatarUrl?: string;
}

export interface CommitHistoryPage {
  commits: CommitListEntry[];
  /** More history exists below this page. */
  hasMore: boolean;
  /** The base ref the divider represents (echoed for the divider label). */
  base: string;
}

/** Full metadata for ONE commit — the description card above the all-files
 * view when a `commit:<sha>` diff is active. */
export interface CommitDiffInfo {
  sha: string;
  shortSha: string;
  subject: string;
  /** Full message body (everything after the subject), "" when absent.
   * Rendered as markdown client-side. */
  body: string;
  author: string;
  authorEmail: string;
  /** Committer time, epoch milliseconds. Clients format it themselves —
   * git's `%cr` relative strings are locale-dependent (gettext), so a
   * pre-formatted string couldn't be compacted reliably. */
  committedAt: number;
  /** Author profile image (server-enriched via commit-avatars). */
  avatarUrl?: string;
}

/**
 * Fetch one commit's metadata for the description card. Best-effort: null
 * when the sha is invalid or doesn't resolve (callers omit the sidecar).
 */
export async function getCommitDiffInfo(
  runtime: ReviewGitRuntime,
  sha: string,
  cwd?: string,
): Promise<CommitDiffInfo | null> {
  if (!BARE_HEX_SHA_RE.test(sha)) return null;
  // Body (%b) is multiline, so it must be the LAST field — the rejoin target
  // of the shared splitter. A literal US byte in the subject would shift the
  // split (same accepted pathological edge as the list parsers).
  const fmt = ["%H", "%h", "%an", "%ae", "%ct", "%s", "%b"].join(COMMIT_FIELD_SEP);
  const result = await runtime.runGit(
    ["--no-optional-locks", "show", "-s", `--pretty=format:${fmt}`, "--end-of-options", sha],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const fields = splitCommitFormatFields(result.stdout, 6, 0);
  if (!fields) return null;
  const [fullSha, shortSha, author, authorEmail, ct, subject, body] = fields;
  return {
    sha: fullSha,
    shortSha,
    author,
    authorEmail,
    committedAt: (Number(ct) || 0) * 1000,
    subject,
    body: body.trim(),
  };
}

const COMMIT_HISTORY_LIMIT_DEFAULT = 50;
const COMMIT_HISTORY_LIMIT_MAX = 200;

/**
 * One page of the linear (`--first-parent`) history from HEAD. Returns null
 * when the repo can't answer at all (no HEAD, not a repo); an unresolvable
 * `before` yields an empty terminal page instead (the commit paged past may
 * be a root commit, whose `^` doesn't resolve).
 */
export async function listCommitHistory(
  runtime: ReviewGitRuntime,
  defaultBranch: string,
  cwd?: string,
  options?: { limit?: number; before?: string },
): Promise<CommitHistoryPage | null> {
  const requested = options?.limit ?? COMMIT_HISTORY_LIMIT_DEFAULT;
  const limit = Math.max(1, Math.min(Math.floor(requested), COMMIT_HISTORY_LIMIT_MAX));
  const before = options?.before;
  // `before` flows into a git argv position — same bare-hex rule as commit:<sha>.
  if (before !== undefined && !BARE_HEX_SHA_RE.test(before)) return null;
  const emptyPage: CommitHistoryPage = { commits: [], hasMore: false, base: defaultBranch };

  // --no-optional-locks throughout: read-only queries that may run while the
  // agent stages/commits concurrently.
  const runReadOnlyGit = (args: string[]) =>
    runtime.runGit(["--no-optional-locks", ...args], { cwd });

  // A cursor from a rewritten history (rebase/force-push mid-session) still
  // resolves in the object store but is no longer on the branch — paging on
  // from it would walk the orphaned pre-rewrite chain. A non-ancestor (or
  // vanished) cursor ends the pagination with an empty terminal page; the
  // client's freshness poll replaces the list moments later.
  if (before) {
    const onBranch = await runReadOnlyGit([
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      before,
      "HEAD",
    ]);
    if (onBranch.exitCode !== 0) return emptyPage;
  }

  // Continue the first-parent walk from `before`'s first parent. +1 over the
  // limit so hasMore is observed, not guessed.
  const startRef = before ? `${before}^` : "HEAD";
  const fmt = ["%H", "%h", "%s", "%ct", "%an", "%ae"].join(COMMIT_FIELD_SEP);
  const log = await runReadOnlyGit([
    "log",
    "--first-parent",
    `--max-count=${limit + 1}`,
    `--pretty=format:${fmt}`,
    "--end-of-options",
    startRef,
  ]);
  if (log.exitCode !== 0) {
    // Paging past a root commit (`before^` unresolvable) is a normal terminal
    // page. A first page failing because the repo simply has no commits yet
    // (no HEAD) is also an empty page, not an error — every other review
    // surface degrades gracefully on a commit-less repo. Anything else
    // (not a repo at all) stays null → the endpoint reports a real error.
    if (before) return emptyPage;
    const headResolves =
      (await runReadOnlyGit(["rev-parse", "--verify", "--quiet", "HEAD"])).exitCode === 0;
    return headResolves ? null : emptyPage;
  }

  const parsed: Array<Omit<CommitListEntry, "isHead" | "isPastBase">> = [];
  for (const line of log.stdout.split("\n")) {
    if (!line) continue;
    const fields = splitCommitFormatFields(line, 2, 3);
    if (!fields) continue;
    const [sha, shortSha, subject, ct, author, authorEmail] = fields;
    parsed.push({
      sha,
      shortSha,
      subject,
      committedAt: (Number(ct) || 0) * 1000,
      author,
      authorEmail,
    });
  }
  const hasMore = parsed.length > limit;
  const page = parsed.slice(0, limit);

  const [head, branchOnly] = await Promise.all([
    runReadOnlyGit(["rev-parse", "HEAD"]),
    // The branch-local set: first-parent commits from HEAD NOT reachable from
    // the base. Reachability (not merge-base position) is what the divider
    // means — a base merged INTO the branch keeps its commits below the line.
    // Best-effort: an unresolvable base yields no divider (all isPastBase
    // false), matching how since-base degrades on such repos.
    defaultBranch
      ? runReadOnlyGit(["rev-list", "--first-parent", "--end-of-options", "HEAD", `^${defaultBranch}`])
      : Promise.resolve(null),
  ]);
  const headSha = head.exitCode === 0 ? head.stdout.trim() : "";
  const branchLocal = branchOnly && branchOnly.exitCode === 0
    ? new Set(branchOnly.stdout.split("\n").filter(Boolean))
    : null;

  return {
    commits: page.map((c) => ({
      ...c,
      isHead: c.sha === headSha,
      isPastBase: branchLocal ? !branchLocal.has(c.sha) : false,
    })),
    hasMore,
    base: defaultBranch,
  };
}

