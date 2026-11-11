export const JJ_TRUNK_REVSET = "trunk()";

export type DiffType =
  | "since-base"
  | "local-vs-remote"
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "jj-current"
  | "jj-last"
  | "jj-line"
  | "jj-all"
  | "jj-evolog"
  | "branch"
  | "merge-base"
  | "all"
  | `commit:${string}`
  | `jj-commit:${string}`
  | `worktree:${string}`
  | `gitbutler:${string}`
  | "static-patch"
  | "p4-default"
  | `p4-changelist:${string}`;

export function parseRemoteBookmark(target: string): { name: string; remote: string } | null {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  return { name: target.slice(0, at), remote: target.slice(at + 1) };
}

const JJ_FULL_COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function jjCompareTargetRevset(target: string): string {
  const remoteBookmark = parseRemoteBookmark(target);
  if (remoteBookmark) {
    return `remote_bookmarks(exact:${quoteJjString(remoteBookmark.name)}, exact:${quoteJjString(remoteBookmark.remote)})`;
  }

  // The resolved line base is a bare commit id whenever its fork point carries no usable bookmark.
  // It has no separators, so it would otherwise read as a local bookmark name and build
  // `bookmarks(exact:"<sha>")`, which resolves to no revisions at all and makes the whole Line of
  // work diff fail.
  if (JJ_FULL_COMMIT_ID.test(target)) return target;

  const localBookmark = parseJjBookmarkName(target);
  return localBookmark ? `bookmarks(exact:${quoteJjString(localBookmark)})` : target;
}

export function jjLineBaseRevset(target: string): string {
  const compareTarget = jjCompareTargetRevset(target);
  return `heads(::@ & ::(${compareTarget}))`;
}

function parseJjBookmarkName(target: string): string | null {
  if (!target || target.startsWith("@") || /[()\s]/.test(target)) return null;
  return target;
}

function quoteJjString(value: string): string {
  return JSON.stringify(value);
}

const WORKTREE_SUB_TYPES = new Set([
  "since-base",
  "local-vs-remote",
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
  "all",
]);

/**
 * Bare hex object name (full or abbreviated) — the only sha shape accepted from clients before it
 * reaches a git argv position.
 */
export const BARE_HEX_SHA_RE = /^[0-9a-f]{4,64}$/i;

/** Parse a `commit:<sha>` diff type — a single historical commit reviewed against its first parent. */
export function parseCommitDiffType(diffType: string): { sha: string } | null {
  if (!diffType.startsWith("commit:")) return null;
  const sha = diffType.slice("commit:".length);
  return BARE_HEX_SHA_RE.test(sha) ? { sha } : null;
}

export function parseJjCommitDiffType(diffType: string): { commitId: string } | null {
  if (!diffType.startsWith("jj-commit:")) return null;
  const commitId = diffType.slice("jj-commit:".length);
  return BARE_HEX_SHA_RE.test(commitId) ? { commitId } : null;
}

/** The revset naming exactly one jj revision by commit id (see parseJjCommitDiffType). */
export function jjCommitRevset(commitId: string): string {
  return `commit_id(${commitId})`;
}

export function commitFamilyId(diffType: string): string | null {
  const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
  return parseCommitDiffType(effective)?.sha ?? parseJjCommitDiffType(effective)?.commitId ?? null;
}

export function parseWorktreeDiffType(
  diffType: string,
): { path: string; subType: string } | null {
  if (!diffType.startsWith("worktree:")) return null;

  const rest = diffType.slice("worktree:".length);
  // An empty worktree path is never valid: it would resolve to an empty cwd, and Bun.spawn({ cwd:
  // "" }) silently runs git in the SERVER's own directory rather than the target repo — leaking an
  // unrelated checkout's diff.
  const finalize = (path: string, subType: string) =>
    path === "" ? null : { path, subType };

  const commitIdx = rest.lastIndexOf(":commit:");
  if (commitIdx !== -1) {
    const maybeCommit = rest.slice(commitIdx + 1);
    if (parseCommitDiffType(maybeCommit)) {
      return finalize(rest.slice(0, commitIdx), maybeCommit);
    }
  }
  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1) {
    const maybeSub = rest.slice(lastColon + 1);
    if (WORKTREE_SUB_TYPES.has(maybeSub)) {
      return finalize(rest.slice(0, lastColon), maybeSub);
    }
  }

  return finalize(rest, "uncommitted");
}
