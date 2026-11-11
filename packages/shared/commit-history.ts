/** Data layer of the Commits panel: linear `--first-parent` pages plus one commit's metadata. The `commit:<sha>` diff plumbing stays in review-core, `jj-commit:<id>` in jj-core. Runtime-agnostic. */

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

export interface CommitListEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  authorEmail: string;
  /** Epoch milliseconds: git's `%cr` relative strings are locale-dependent. */
  committedAt: number;
  isHead: boolean;
  isPastBase: boolean;
  avatarUrl?: string;
}

export interface CommitHistoryPage {
  commits: CommitListEntry[];
  hasMore: boolean;
  base: string;
}

export interface CommitDiffInfo {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  /** Epoch milliseconds: git's `%cr` relative strings are locale-dependent. */
  committedAt: number;
  avatarUrl?: string;
}

export async function getCommitDiffInfo(
  runtime: ReviewGitRuntime,
  sha: string,
  cwd?: string,
): Promise<CommitDiffInfo | null> {
  if (!BARE_HEX_SHA_RE.test(sha)) return null;
  // Body (%b) is multiline, so it must be the LAST field. A literal US byte in the subject would shift the split (accepted edge).
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

  // A cursor from rewritten history still resolves in the object store but is off the branch: paging from it would walk the orphaned chain, so a non-ancestor (or vanished) cursor ends with an empty terminal page.
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
    // Paging past a root commit, or a first page on a repo with no commits yet, is an empty page; anything else (not a repo at all) stays null.
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
    // Branch-local set: first-parent commits from HEAD not reachable from the base (a base merged into the branch keeps its commits below the line). An unresolvable base yields no divider.
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


// jj has no HEAD: the rail starts at `@` and walks first parents (`first_ancestors`, jj >= 0.33). `@` is skipped when it is a fresh empty working copy, which would otherwise be the row the panel auto-opens.

const JJ_FIELD_JOIN = ' ++ "\\t" ++ ';

const JJ_COMMIT_ROW_TEMPLATE = [
  "commit_id",
  "change_id.short(8)",
  "json(description.first_line())",
  'committer.timestamp().format("%s")',
  "json(author.name())",
  "json(stringify(author.email()))",
  'if(current_working_copy, "1", "0") ++ if(empty, "1", "0") ++ if(description, "1", "0") ++ if(parents.len() > 1, "1", "0")',
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
    // Blank = the usual fresh `jj new`: no changes, no description, ONE
    // parent. A merge working copy (`jj new A B`) is "empty" against the
    // auto-merge of its parents yet has a real first-parent diff, so it stays.
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
      blankWorkingCopy: isHead && flags[1] === "1" && flags[2] === "0" && flags[3] === "0",
    });
  }
  return rows;
}

/** The jj session base is the compare target, except while an Evolution diff is active (an earlier state of `@`), when the context's default target stands in. */
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

  // A cursor must still be on the rail: rewritten history leaves the old id resolvable but off `@`'s line.
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
    // jj < 0.33 has no first_ancestors(); anything else is a real failure.
    if (/Function `?first_ancestors`? doesn't exist/.test(result.stderr)) {
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
