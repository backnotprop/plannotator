import { basename } from "node:path";
import {
  type DiffResult,
  type DiffType,
  type GitCommandResult,
  type GitContext,
  type GitDiffOptions,
  type JjEvoLogEntry,
  JJ_TRUNK_REVSET,
  jjLineBaseRevset,
  validateFilePath,
} from "./review-core";

export {
  JJ_TRUNK_REVSET,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseRemoteBookmark,
  type JjEvoLogEntry,
} from "./review-core";

export interface ReviewJjRuntime {
  runJj: (
    args: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ) => Promise<GitCommandResult>;
}

export async function detectJjWorkspace(
  runtime: ReviewJjRuntime,
  cwd?: string,
): Promise<string | null> {
  const result = await runtime.runJj(["workspace", "root"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

export async function getJjContext(
  runtime: ReviewJjRuntime,
  cwd?: string,
): Promise<GitContext> {
  const root = await detectJjWorkspace(runtime, cwd);
  const targets = await listJjCompareTargets(runtime, root ?? cwd);
  const defaultTarget = await selectDefaultJjCompareTarget(runtime, root ?? cwd);
  const contextCwd = root ?? cwd;

  const evologs = await getJjEvoLogEntries(runtime, root ?? cwd);

  return {
    currentBranch: "",
    defaultBranch: defaultTarget,
    diffOptions: [
      { id: "jj-current", label: "Current change" },
      { id: "jj-last", label: "Last change" },
      { id: "jj-line", label: "Line of work" },
      ...(evologs.length >= 2 ? [{ id: "jj-evolog", label: "Evolution diff" }] : []),
      { id: "jj-all", label: "All files" },
    ],
    worktrees: [],
    availableBranches: targets,
    compareTarget: {
      diffTypes: ["jj-line"],
      fallback: defaultTarget,
      picker: {
        rowLabel: "from revision",
        triggerLabel: "revision",
        triggerTitlePrefix: "Compare against",
        searchPlaceholder: "Search bookmarks...",
        emptyText: "No bookmarks match.",
        localGroupLabel: "Bookmarks",
        remoteGroupLabel: "Remote bookmarks",
      },
    },
    repository: contextCwd ? { displayFallback: basename(contextCwd) } : undefined,
    cwd: contextCwd,
    vcsType: "jj",
    jjEvologs: evologs.length >= 2 ? evologs : undefined,
  };
}

export async function runJjDiff(
  runtime: ReviewJjRuntime,
  diffType: DiffType,
  defaultBranch: string,
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  let compareTarget = defaultBranch.length > 0 ? defaultBranch : JJ_TRUNK_REVSET;

  // For evolog diffs, when no explicit base is provided, default to the
  // second evolog entry (the previous state of the current change).
  if (diffType === "jj-evolog" && defaultBranch.length === 0) {
    const evologs = await getJjEvoLogEntries(runtime, cwd);
    if (evologs.length < 2) {
      return { patch: "", label: "Evolution diff", error: "No previous evolution found" };
    }
    compareTarget = evologs[1].commitId;
  }

  const args = getJjDiffArgs(diffType, compareTarget, options);
  if (!args) return { patch: "", label: "Unknown diff type" };

  const result = await runtime.runJj(args.args, { cwd });
  if (result.exitCode !== 0) {
    return { patch: "", label: args.label, error: firstErrorLine(result.stderr) };
  }

  const patch = options?.hideWhitespace ? dropHunklessGitDiffChunks(result.stdout) : result.stdout;
  return { patch, label: args.label };
}

function dropHunklessGitDiffChunks(patch: string): string {
  if (!patch.includes("diff --git ")) return patch;

  const chunks = patch.split(/^diff --git /m);
  const prefix = chunks.shift() ?? "";
  const filtered = chunks
    .filter(hasReviewableGitDiffChunk)
    .map((chunk) => `diff --git ${chunk}`)
    .join("");

  return `${prefix}${filtered}`;
}

function hasReviewableGitDiffChunk(chunk: string): boolean {
  if (/^@@@? /m.test(chunk)) return true;
  return /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to|GIT binary patch|Binary files |similarity index|dissimilarity index)/m.test(chunk);
}

export async function getJjFileContentsForDiff(
  runtime: ReviewJjRuntime,
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  validateFilePath(filePath);
  if (oldPath) validateFilePath(oldPath);

  const oldFilePath = oldPath === undefined || oldPath.length === 0 ? filePath : oldPath;
  const root = await detectJjWorkspace(runtime, cwd);
  const fileCwd = root ?? cwd;

  switch (diffType) {
    case "jj-current":
      return {
        oldContent: await jjFileContent(runtime, "@-", oldFilePath, fileCwd),
        newContent: await jjFileContent(runtime, "@", filePath, fileCwd),
      };
    case "jj-last": {
      const parentRev = await resolveJjParent(runtime, "@-", fileCwd);
      return {
        oldContent: parentRev ? await jjFileContent(runtime, parentRev, oldFilePath, fileCwd) : null,
        newContent: await jjFileContent(runtime, "@-", filePath, fileCwd),
      };
    }
    case "jj-line": {
      const compareTarget = defaultBranch.length > 0 ? defaultBranch : JJ_TRUNK_REVSET;
      return {
        oldContent: await jjFileContent(runtime, jjLineBaseRevset(compareTarget), oldFilePath, fileCwd),
        newContent: await jjFileContent(runtime, "@", filePath, fileCwd),
      };
    }
    case "jj-evolog": {
      // defaultBranch carries the evolog commit ID of the historical state.
      const evologRev = defaultBranch.length > 0 ? defaultBranch : "@-";
      return {
        oldContent: await jjFileContent(runtime, evologRev, oldFilePath, fileCwd),
        newContent: await jjFileContent(runtime, "@", filePath, fileCwd),
      };
    }
    case "jj-all":
      return {
        oldContent: null,
        newContent: await jjFileContent(runtime, "@", filePath, fileCwd),
      };
    default:
      return { oldContent: null, newContent: null };
  }
}

export function getJjDiffArgs(
  diffType: DiffType,
  compareTarget: string,
  options?: GitDiffOptions,
): { args: string[]; label: string } | null {
  const whitespaceArgs = options?.hideWhitespace ? ["-w"] : [];

  switch (diffType) {
    case "jj-current":
      return { args: ["diff", "--git", ...whitespaceArgs, "-r", "@"], label: "Current change" };
    case "jj-last":
      return { args: ["diff", "--git", ...whitespaceArgs, "-r", "@-"], label: "Last change" };
    case "jj-line":
      return {
        args: ["diff", "--git", ...whitespaceArgs, "--from", jjLineBaseRevset(compareTarget), "--to", "@"],
        label: `Line of work vs ${compareTarget}`,
      };
    case "jj-evolog":
      // compareTarget is the short commit ID of an older evolog entry.
      // Diff from that historical state to the current working copy.
      return {
        args: ["diff", "--git", ...whitespaceArgs, "--from", compareTarget, "--to", "@"],
        label: `Evolution diff from ${compareTarget.slice(0, 8)}`,
      };
    case "jj-all":
      return { args: ["diff", "--git", ...whitespaceArgs, "--from", "root()", "--to", "@"], label: "All files" };
    default:
      return null;
  }
}

export async function selectDefaultJjCompareTarget(
  runtime: ReviewJjRuntime,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runJj([
    "log",
    "--no-graph",
    "-r",
    JJ_TRUNK_REVSET,
    "-T",
    "json(bookmarks)",
  ], { cwd });
  if (result.exitCode !== 0) return JJ_TRUNK_REVSET;

  return parseJjResolvedBookmarks(result.stdout)[0] ?? JJ_TRUNK_REVSET;
}

function parseJjResolvedBookmarks(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];

    const local: string[] = [];
    const remote: string[] = [];

    for (const bookmark of parsed) {
      if (typeof bookmark === "string") {
        local.push(bookmark);
        continue;
      }

      if (!bookmark || typeof bookmark !== "object") continue;

      const name = typeof bookmark.name === "string" ? bookmark.name : null;
      if (!name) continue;

      const remoteName = typeof bookmark.remote === "string" ? bookmark.remote : null;
      if (remoteName) {
        remote.push(`${name}@${remoteName}`);
        continue;
      }

      local.push(name);
    }

    return [...remote, ...local];
  } catch {
    return [];
  }
}

async function listJjCompareTargets(
  runtime: ReviewJjRuntime,
  cwd?: string,
): Promise<{ local: string[]; remote: string[] }> {
  const [localResult, remoteResult] = await Promise.all([
    runtime.runJj([
      "bookmark",
      "list",
      "--sort",
      "committer-date-",
      "--sort",
      "name",
      "-T",
      "if(remote, '', if(present, json(name) ++ '\\n', ''))",
    ], { cwd }),
    runtime.runJj([
      "bookmark",
      "list",
      "--all-remotes",
      "--sort",
      "committer-date-",
      "--sort",
      "name",
      "-T",
      "if(remote, if(present, json(name) ++ '\\t' ++ json(remote) ++ '\\n', ''), '')",
    ], { cwd }),
  ]);

  const local = localResult.exitCode === 0 ? parseJjBookmarkList(localResult.stdout) : [];
  const remote = remoteResult.exitCode === 0 ? parseJjRemoteBookmarkList(remoteResult.stdout) : [];

  return {
    local,
    remote,
  };
}

export function parseJjBookmarkList(stdout: string): string[] {
  const seen = new Set<string>();
  const bookmarks: string[] = [];

  for (const rawLine of splitJjTemplateRecords(stdout)) {
    const line = rawLine.trim();
    if (!line) continue;

    const bookmark = parseSerializedJjString(line);
    if (!bookmark || seen.has(bookmark)) continue;

    seen.add(bookmark);
    bookmarks.push(bookmark);
  }

  return bookmarks;
}

export function parseJjRemoteBookmarkList(stdout: string): string[] {
  const seen = new Set<string>();
  const bookmarks: string[] = [];

  for (const rawLine of splitJjTemplateRecords(stdout)) {
    const line = rawLine.trim();
    if (!line) continue;

    const fields = splitJjTemplateFields(line);
    if (!fields) continue;

    const [nameField, remoteField] = fields;
    const name = parseSerializedJjString(nameField);
    const remote = parseSerializedJjString(remoteField);
    if (!name || !remote) continue;

    const bookmark = `${name}@${remote}`;
    if (seen.has(bookmark)) continue;

    seen.add(bookmark);
    bookmarks.push(bookmark);
  }

  return bookmarks;
}

function splitJjTemplateRecords(stdout: string): string[] {
  return stdout.split(/\n|\\n/g);
}

function splitJjTemplateFields(line: string): [string, string] | null {
  const literalTab = line.indexOf("\t");
  if (literalTab !== -1) return [line.slice(0, literalTab), line.slice(literalTab + 1)];

  const escapedTab = line.indexOf("\\t");
  if (escapedTab !== -1) return [line.slice(0, escapedTab), line.slice(escapedTab + 2)];

  return null;
}

function parseSerializedJjString(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Returns the evolution log for the current change (`@`), newest-first.
 * Each entry represents a previous state of the same change ID.
 * Returns an empty array if evolog is unavailable or the change has no history.
 */
export async function getJjEvoLogEntries(
  runtime: ReviewJjRuntime,
  cwd?: string,
): Promise<JjEvoLogEntry[]> {
  // Template uses CommitEvolutionEntry type: each field is accessed via `commit.*`.
  const result = await runtime.runJj(
    [
      "evolog",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'commit.commit_id().short(12) ++ "\t" ++ commit.description().first_line() ++ "\t" ++ commit.author().timestamp().ago() ++ "\n"',
    ],
    { cwd },
  );

  if (result.exitCode !== 0) return [];

  const entries: JjEvoLogEntry[] = [];
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tabIdx = line.indexOf("\t");
    if (tabIdx === -1) continue;
    const commitId = line.slice(0, tabIdx);
    const rest = line.slice(tabIdx + 1);
    const tab2 = rest.indexOf("\t");
    const description = tab2 === -1 ? rest : rest.slice(0, tab2);
    const age = tab2 === -1 ? undefined : rest.slice(tab2 + 1);
    if (commitId) entries.push({ commitId, description, age });
  }

  return entries;
}

async function jjFileContent(
  runtime: ReviewJjRuntime,
  rev: string,
  filePath: string,
  cwd?: string,
): Promise<string | null> {
  const result = await runtime.runJj(["file", "show", "-r", rev, "--", filePath], { cwd });
  return result.exitCode === 0 ? result.stdout : null;
}

async function resolveJjParent(
  runtime: ReviewJjRuntime,
  rev: string,
  cwd?: string,
): Promise<string | null> {
  const result = await runtime.runJj(["log", "-r", rev, "--no-graph", "-T", "parents.map(|p| p.change_id()).join(' ')", "--limit", "1"], { cwd });
  const parent = result.stdout.trim().split(/\s+/).find(Boolean);
  return result.exitCode === 0 && parent ? parent : null;
}

function firstErrorLine(stderr: string): string | undefined {
  const line = stderr.split("\n").find((value) => value.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > 200 ? line.slice(0, 200) + "..." : line;
}
