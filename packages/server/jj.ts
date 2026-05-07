import {
  type DiffResult,
  type DiffType,
  type GitCommandResult,
  type GitContext,
  type GitDiffOptions,
  validateFilePath,
} from "@plannotator/shared/review-core";
import { basename } from "node:path";

const JJ_TRUNK_REVSET = "trunk()";

async function runJj(
  args: string[],
  options?: { cwd?: string },
): Promise<GitCommandResult> {
  try {
    const proc = Bun.spawn(["jj", ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "jj not found", exitCode: 1 };
  }
}

export async function detectJjWorkspace(cwd?: string): Promise<string | null> {
  const result = await runJj(["workspace", "root"], { cwd });
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

export async function getJjContext(cwd?: string): Promise<GitContext> {
  const root = await detectJjWorkspace(cwd);
  const targets = await listJjCompareTargets(root ?? cwd);
  const defaultTarget = selectDefaultJjCompareTarget(targets);
  const contextCwd = root ?? cwd;

  return {
    currentBranch: "",
    defaultBranch: defaultTarget,
    diffOptions: [
      { id: "jj-current", label: "Current change" },
      { id: "jj-last", label: "Last change" },
      { id: "jj-line", label: "Line of work" },
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
        searchPlaceholder: "Search bookmarks…",
        emptyText: "No bookmarks match.",
        localGroupLabel: "Bookmarks",
        remoteGroupLabel: "Remote bookmarks",
      },
    },
    repository: contextCwd ? { displayFallback: basename(contextCwd) } : undefined,
    cwd: contextCwd,
    vcsType: "jj",
  };
}

export async function runJjDiff(
  diffType: DiffType,
  defaultBranch: string,
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  const compareTarget = defaultBranch.length > 0 ? defaultBranch : JJ_TRUNK_REVSET;
  const args = getJjDiffArgs(diffType, compareTarget, options);
  if (!args) return { patch: "", label: "Unknown diff type" };

  const result = await runJj(args.args, { cwd });
  if (result.exitCode !== 0) {
    return { patch: "", label: args.label, error: firstErrorLine(result.stderr) };
  }

  return { patch: result.stdout, label: args.label };
}

export async function getJjFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  validateFilePath(filePath);
  if (oldPath) validateFilePath(oldPath);

  const oldFilePath = oldPath === undefined || oldPath.length === 0 ? filePath : oldPath;
  const root = await detectJjWorkspace(cwd);
  const fileCwd = root ?? cwd;

  switch (diffType) {
    case "jj-current":
      return {
        oldContent: await jjFileContent("@-", oldFilePath, fileCwd),
        newContent: await jjFileContent("@", filePath, fileCwd),
      };
    case "jj-last": {
      const parentRev = await resolveJjParent("@-", fileCwd);
      return {
        oldContent: parentRev ? await jjFileContent(parentRev, oldFilePath, fileCwd) : null,
        newContent: await jjFileContent("@-", filePath, fileCwd),
      };
    }
    case "jj-line":
      const compareTarget = defaultBranch.length > 0 ? defaultBranch : JJ_TRUNK_REVSET;
      return {
        oldContent: await jjFileContent(jjLineBaseRevset(compareTarget), oldFilePath, fileCwd),
        newContent: await jjFileContent("@", filePath, fileCwd),
      };
    case "jj-all":
      return {
        oldContent: null,
        newContent: await jjFileContent("@", filePath, fileCwd),
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
    case "jj-all":
      return { args: ["diff", "--git", ...whitespaceArgs, "--from", "root()", "--to", "@"], label: "All files" };
    default:
      return null;
  }
}

export function selectDefaultJjCompareTarget(_targets: { local: string[]; remote: string[] }): string {
  // `trunk()` honors JJ's repository default bookmark/remote and user aliases;
  // bookmarks are still listed so users can explicitly pick a different base.
  return JJ_TRUNK_REVSET;
}

export function jjCompareTargetRevset(target: string): string {
  const remoteBookmark = parseRemoteBookmark(target);
  if (remoteBookmark) {
    return `remote_bookmarks(exact:${quoteJjString(remoteBookmark.name)}, exact:${quoteJjString(remoteBookmark.remote)})`;
  }
  const localBookmark = parseBookmarkName(target);
  return localBookmark ? `bookmarks(exact:${quoteJjString(localBookmark)})` : target;
}

export function jjLineBaseRevset(target: string): string {
  const compareTarget = jjCompareTargetRevset(target);
  return `heads(::@ & ::(${compareTarget}))`;
}

export function parseRemoteBookmark(target: string): { name: string; remote: string } | null {
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) return null;
  return { name: target.slice(0, at), remote: target.slice(at + 1) };
}

function parseBookmarkName(target: string): string | null {
  if (!target || target.startsWith("@") || /[()\s]/.test(target)) return null;
  return target;
}

function quoteJjString(value: string): string {
  return JSON.stringify(value);
}

async function listJjCompareTargets(cwd?: string): Promise<{ local: string[]; remote: string[] }> {
  const [localResult, remoteResult] = await Promise.all([
    runJj([
      "bookmark",
      "list",
      "--sort",
      "committer-date-",
      "--sort",
      "name",
      "-T",
      "if(remote, '', if(present, json(name) ++ '\n', ''))",
    ], { cwd }),
    runJj([
      "bookmark",
      "list",
      "--all-remotes",
      "--sort",
      "committer-date-",
      "--sort",
      "name",
      "-T",
      "if(remote, if(present, json(name) ++ '\t' ++ json(remote) ++ '\n', ''), '')",
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

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\\n$/, "").trim();
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

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\\n$/, "").trim();
    if (!line) continue;

    const separator = line.indexOf("\t");
    if (separator === -1) continue;

    const name = parseSerializedJjString(line.slice(0, separator));
    const remote = parseSerializedJjString(line.slice(separator + 1));
    if (!name || !remote || remote === "git") continue;

    const bookmark = `${name}@${remote}`;
    if (seen.has(bookmark)) continue;

    seen.add(bookmark);
    bookmarks.push(bookmark);
  }

  return bookmarks;
}

function parseSerializedJjString(value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

async function jjFileContent(rev: string, filePath: string, cwd?: string): Promise<string | null> {
  const result = await runJj(["file", "show", "-r", rev, "--", filePath], { cwd });
  return result.exitCode === 0 ? result.stdout : null;
}

async function resolveJjParent(rev: string, cwd?: string): Promise<string | null> {
  const result = await runJj(["log", "-r", rev, "--no-graph", "-T", "parents.map(|p| p.change_id()).join(' ')", "--limit", "1"], { cwd });
  const parent = result.stdout.trim().split(/\s+/).find(Boolean);
  return result.exitCode === 0 && parent ? parent : null;
}

function firstErrorLine(stderr: string): string | undefined {
  const line = stderr.split("\n").find((value) => value.trim().length > 0)?.trim();
  if (!line) return undefined;
  return line.length > 200 ? line.slice(0, 200) + "..." : line;
}
