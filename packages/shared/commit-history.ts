/**
 * Commit-history rail — backs GET /api/commits and the commitInfo sidecar.
 *
 * Runtime-agnostic like review-core (Pi consumes a build-time copy via
 * vendor.sh). Deliberately separate from review-core: nothing here
 * participates in the diff-type dispatch — it is the Commits panel's data
 * layer (linear --first-parent pages + one commit's full metadata). The
 * commit:<sha> DIFF plumbing (parseCommitDiffType, the runGitDiff /
 * fingerprint / file-contents cases) stays in review-core with the other
 * diff types; the jj-commit:<id> plumbing likewise stays in jj-core. The jj
 * rail and card live at the bottom of this file.
 */

import {
  BARE_HEX_SHA_RE,
  COMMIT_FIELD_SEP,
  jjCommitRevset,
  jjCompareTargetRevset,
  splitCommitFormatFields,
  type GitContext,
  type ReviewGitRuntime,
} from "./review-core";
import type { ReviewJjRuntime } from "./jj-core";

// --- Commit history rail ------------------------------------------------------
//
// Backs GET /api/commits: the Commits panel's linear `--first-parent` walk from
// HEAD, newest first. Paged (before = the previous page's last sha), with a
// per-commit "past the base" flag so the client can draw the divider where the
// branch meets the resolved base.

export interface CommitListEntry {
  /** Full SHA — sent back as `commit:<sha>` on click (in a jj session the
   * full commit id, sent back as `jj-commit:<id>`). */
  sha: string;
  /** Display id: the abbreviated sha, or in a jj session the short CHANGE id,
   * the identity jj users read (`sha` stays the commit id). */
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


// --- Jujutsu -----------------------------------------------------------------
//
// The same rail and card for a jj session. jj has no HEAD: the rail starts at
// the working-copy revision `@` and walks FIRST parents (`first_ancestors`,
// jj >= 0.33), which is what git's `--first-parent` walk is on a merge. The
// virtual root is never a row. `@` is skipped when it is the usual fresh
// working copy (no changes, no description): its diff is empty, and it would
// otherwise be the row the panel auto-opens. `isHead` marks `@` itself.

const JJ_FIELD_JOIN = ' ++ "\\t" ++ ';

const JJ_COMMIT_ROW_TEMPLATE = [
  "commit_id",
  "change_id.short(8)",
  "json(description.first_line())",
  'committer.timestamp().format("%s")',
  "json(author.name())",
  "json(stringify(author.email()))",
  'if(current_working_copy, "1", "0") ++ if(empty, "1", "0") ++ if(description, "1", "0")',
].join(JJ_FIELD_JOIN) + ' ++ "\\n"';

const JJ_COMMIT_ID_TEMPLATE = 'commit_id ++ "\\n"';

const JJ_NO_DESCRIPTION = "(no description set)";

function parseJjJsonString(value: string | undefined): string {
  try {
    const parsed = JSON.parse(value ?? "");
    return typeof parsed === "string" ? parsed : "";
  } catch {
    return "";
  }
}

interface JjRailRow {
  entry: Omit<CommitListEntry, "isPastBase">;
  /** An empty working copy with no description (a fresh `jj new`). */
  blankWorkingCopy: boolean;
}

function parseJjRailRows(stdout: string): JjRailRow[] {
  const rows: JjRailRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const fields = line.split("\t");
    if (fields.length < 7) continue;
    const [sha, shortSha, subjectField, seconds, authorField, emailField, flags] = fields;
    if (!BARE_HEX_SHA_RE.test(sha)) continue;
    const isHead = flags[0] === "1";
    rows.push({
      entry: {
        sha,
        shortSha,
        subject: parseJjJsonString(subjectField) || JJ_NO_DESCRIPTION,
        committedAt: (Number(seconds) || 0) * 1000,
        author: parseJjJsonString(authorField),
        authorEmail: parseJjJsonString(emailField),
        isHead,
      },
      blankWorkingCopy: isHead && flags[1] === "1" && flags[2] === "0",
    });
  }
  return rows;
}

/**
 * The compare target the jj rail's divider stands for, plus its label. The
 * session base is the jj compare target (the line-of-work fork point, or a
 * bookmark the reviewer picked) EXCEPT while an Evolution diff is active,
 * when it is an earlier state of `@` rather than a line base, so the
 * context's own default target stands in. A full commit id reads as the
 * bookmark the line-base resolution names, else as a 12-character id.
 */
export function resolveJjCommitRailBase(
  currentBase: string,
  context: Pick<GitContext, "defaultBranch" | "jjEvologs" | "jjLineBase"> | undefined,
): { target: string; label: string } {
  const isEvolog = context?.jjEvologs?.some((entry) => entry.commitId === currentBase) ?? false;
  const target = !currentBase || isEvolog ? context?.defaultBranch || "trunk()" : currentBase;
  const lineBase = context?.jjLineBase?.kind === "resolved" ? context.jjLineBase.revision : null;
  const label = lineBase && lineBase.commitId === target && lineBase.bookmarks[0]
    ? lineBase.bookmarks[0]
    : /^[0-9a-f]{40,64}$/.test(target)
      ? target.slice(0, 12)
      : target;
  return { target, label };
}

/**
 * One page of a jj session's first-parent history from `@`. Same contract as
 * listCommitHistory: null when jj cannot answer at all, an empty terminal page
 * for a stale `before` cursor. `base` is the jj compare target
 * (resolveJjCommitRailBase) and `baseLabel` what the page echoes for the
 * divider; a target that does not resolve just draws no divider.
 */
export async function listJjCommitHistory(
  runtime: ReviewJjRuntime,
  base: string,
  cwd?: string,
  options?: { limit?: number; before?: string; baseLabel?: string },
): Promise<CommitHistoryPage | null> {
  const requested = options?.limit ?? COMMIT_HISTORY_LIMIT_DEFAULT;
  const limit = Math.max(1, Math.min(Math.floor(requested), COMMIT_HISTORY_LIMIT_MAX));
  const before = options?.before;
  // `before` becomes part of a revset: same bare-hex rule as jj-commit:<id>,
  // and always wrapped in commit_id() so a hex-named bookmark cannot shadow it.
  if (before !== undefined && !BARE_HEX_SHA_RE.test(before)) return null;
  const label = options?.baseLabel ?? base;
  const emptyPage: CommitHistoryPage = { commits: [], hasMore: false, base: label };

  const log = (revset: string, template: string, count: number) =>
    runtime.runJj(
      ["log", "--no-graph", "-r", revset, "-T", template, "--limit", String(count)],
      { cwd },
    );

  // A cursor must still be on the rail: history rewritten mid-session
  // (rebase, abandon, squash) leaves the old id resolvable but off `@`'s line.
  // The client's freshness poll replaces the list moments later.
  if (before) {
    const onRail = await log(`${jjCommitRevset(before)} & first_ancestors(@)`, JJ_COMMIT_ID_TEMPLATE, 1);
    if (onRail.exitCode !== 0 || !onRail.stdout.trim()) return emptyPage;
  }

  const start = before ? `first_parent(${jjCommitRevset(before)})` : "@";
  const rail = `first_ancestors(${start}) ~ root()`;
  // +2: one row to observe hasMore, one for the blank working copy the first
  // page drops.
  const result = await log(rail, JJ_COMMIT_ROW_TEMPLATE, limit + 2);
  if (result.exitCode !== 0) {
    if (/first_ancestors|first_parent/.test(result.stderr)) {
      throw new Error("The Commits view needs Jujutsu 0.33 or newer.");
    }
    return before ? emptyPage : null;
  }

  const rows = parseJjRailRows(result.stdout).filter((row) => !row.blankWorkingCopy);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  // Past-base rows are a suffix of the first-parent chain (`::target` is
  // closed under parents), so the first limit+2 rows of the SAME rail
  // intersected with it cover every past-base row on this page.
  const pastBase = page.length > 0
    ? await log(`(${rail}) & ::(${jjCompareTargetRevset(base)})`, JJ_COMMIT_ID_TEMPLATE, limit + 2)
    : null;
  const pastBaseIds = pastBase && pastBase.exitCode === 0
    ? new Set(pastBase.stdout.split("\n").map((id) => id.trim()).filter(Boolean))
    : null;

  return {
    commits: page.map((row) => ({ ...row.entry, isPastBase: pastBaseIds?.has(row.entry.sha) ?? false })),
    hasMore,
    base: label,
  };
}

/** The description card for a `jj-commit:<commit id>` diff. Best-effort, like getCommitDiffInfo. */
export async function getJjCommitDiffInfo(
  runtime: ReviewJjRuntime,
  commitId: string,
  cwd?: string,
): Promise<CommitDiffInfo | null> {
  if (!BARE_HEX_SHA_RE.test(commitId)) return null;
  const template = [
    "commit_id",
    "change_id.short(8)",
    "json(author.name())",
    "json(stringify(author.email()))",
    'committer.timestamp().format("%s")',
    "json(description)",
  ].join(JJ_FIELD_JOIN);
  const result = await runtime.runJj(
    ["log", "--no-graph", "-r", jjCommitRevset(commitId), "-T", template],
    { cwd },
  );
  if (result.exitCode !== 0) return null;
  const fields = result.stdout.trim().split("\t");
  if (fields.length < 6 || !BARE_HEX_SHA_RE.test(fields[0])) return null;
  const [sha, shortSha, authorField, emailField, seconds, descriptionField] = fields;
  const description = parseJjJsonString(descriptionField);
  const newline = description.indexOf("\n");
  const subject = (newline === -1 ? description : description.slice(0, newline)).trim();
  return {
    sha,
    shortSha,
    subject: subject || JJ_NO_DESCRIPTION,
    body: newline === -1 ? "" : description.slice(newline + 1).trim(),
    author: parseJjJsonString(authorField),
    authorEmail: parseJjJsonString(emailField),
    committedAt: (Number(seconds) || 0) * 1000,
  };
}
