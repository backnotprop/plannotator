/**
 * GitButler utilities for code review
 *
 * Provides virtual-branch diff support for GitButler workspaces.
 * Mirrors the structure of p4.ts for consistent VCS abstraction.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type DiffResult,
  type DiffType,
  type FileMetadata,
  type GitContext,
} from "@plannotator/shared/review-core";
import {
  getCurrentBranch,
  getDefaultBranch,
  getFileContentsForDiff,
} from "./git";

// --- but command runner ---

async function runBut(
  args: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["but", ...args], {
    cwd,
    stdin: new Uint8Array(0),
    stdout: "pipe",
    stderr: "pipe",
  });

  const processResult = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`but ${args[0]} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    return await Promise.race([processResult, timeoutPromise]);
  } catch (err) {
    proc.kill();
    throw err;
  }
}

// --- Detection ---

export async function detectGitButlerRepo(cwd?: string): Promise<boolean> {
  const dir = cwd ?? process.cwd();
  return existsSync(join(dir, ".git", "gitbutler", "but.sqlite"));
}

// --- Context ---

interface ButBranch {
  cliId?: string;
  name?: string;
}

interface ButStatusChange {
  filePath: string;
  changeType: "added" | "modified" | "deleted" | string;
}

interface ButStack {
  cliId?: string;
  branches?: ButBranch[];
  assignedChanges?: ButStatusChange[];
}

interface ButStatusJson {
  stacks?: ButStack[];
  unassignedChanges?: ButStatusChange[];
  mergeBase?: { commitId?: string };
}

export async function getGitButlerContext(cwd?: string): Promise<GitContext> {
  const [currentBranch, defaultBranch, statusResult] = await Promise.all([
    getCurrentBranch(),
    getDefaultBranch(),
    runBut(["status", "-j"], cwd),
  ]);

  const diffOptions = [
    { id: "gitbutler:workspace", label: "Workspace (all changes)" },
  ];
  const virtualBranches: Array<{ id: string; name: string }> = [];

  if (statusResult.exitCode === 0) {
    try {
      const status = JSON.parse(statusResult.stdout) as ButStatusJson;
      for (const stack of status.stacks ?? []) {
        if (!stack.cliId) continue;
        const branches = stack.branches ?? [];
        const topBranchName = branches[0]?.name ?? stack.cliId;
        virtualBranches.push({ id: stack.cliId, name: topBranchName });

        if (branches.length > 1) {
          // Multi-branch stack: show a combined stack option + individual branch options
          diffOptions.push({
            id: `gitbutler:${stack.cliId}`,
            label: `Stack: ${topBranchName} (${branches.length})`,
          });
          for (const branch of branches) {
            if (!branch.cliId || !branch.name) continue;
            diffOptions.push({
              id: `gitbutler:${stack.cliId}:${branch.cliId}`,
              label: `  › ${branch.name}`,
            });
          }
        } else {
          // Single-branch stack: show as a plain branch option
          diffOptions.push({ id: `gitbutler:${stack.cliId}`, label: topBranchName });
        }
      }
    } catch {
      // ignore JSON parse errors — workspace option still available
    }
  }

  return {
    currentBranch,
    defaultBranch,
    diffOptions,
    worktrees: [],
    virtualBranches,
    vcsType: "gitbutler",
    cwd,
  };
}

// GitButler only: per-lane committed/uncommitted breakdown entry.
type LaneDetail = { lane: string; source: "committed" | "uncommitted" };

function addLaneDetail(map: Map<string, LaneDetail[]>, filePath: string, detail: LaneDetail): void {
  const arr = map.get(filePath) ?? [];
  if (!arr.some((d) => d.lane === detail.lane && d.source === detail.source)) arr.push(detail);
  map.set(filePath, arr);
}

function buildFileMeta(fileDetails: Map<string, LaneDetail[]>): Record<string, FileMetadata> {
  const fileMeta: Record<string, FileMetadata> = {};
  for (const [filePath, details] of fileDetails) {
    if (details.length === 0) { fileMeta[filePath] = {}; continue; }
    const lanes = [...new Set(details.map((d) => d.lane))];
    const sources: Array<"committed" | "uncommitted"> = [...new Set(details.map((d) => d.source))];
    const source: FileMetadata["source"] = sources.length === 1 ? sources[0] : "mixed";
    fileMeta[filePath] = lanes.length > 1
      ? { source, lanes, laneDetails: details }
      : { source, lanes };
  }
  return fileMeta;
}

// --- Diff ---

interface ButHunk {
  diff: string;
}

interface ButDiffEntry {
  path: string;
  status: "added" | "modified" | "deleted" | string;
  diff?: { hunks?: ButHunk[] };
}

interface ButDiffJson {
  changes: ButDiffEntry[];
}

async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdin: new Uint8Array(0),
    stdout: "pipe",
    stderr: "pipe",
  });

  const processResult = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    return await Promise.race([processResult, timeoutPromise]);
  } catch (err) {
    proc.kill();
    throw err;
  }
}

function hunkOldStart(hunkDiff: string): number {
  const m = hunkDiff.match(/@@ -(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function mergeChanges(a: ButDiffEntry[], b: ButDiffEntry[]): ButDiffEntry[] {
  const byPath = new Map<string, ButDiffEntry>();
  for (const entry of [...a, ...b]) {
    const existing = byPath.get(entry.path);
    if (!existing) {
      byPath.set(entry.path, { ...entry, diff: { hunks: [...(entry.diff?.hunks ?? [])] } });
    } else {
      const merged = existing.diff!.hunks!;
      for (const hunk of entry.diff?.hunks ?? []) {
        merged.push(hunk);
      }
      merged.sort((x, y) => hunkOldStart(x.diff) - hunkOldStart(y.diff));
    }
  }
  return [...byPath.values()];
}

function buildUnifiedPatch(changes: ButDiffEntry[]): string {
  const parts: string[] = [];
  for (const change of changes) {
    const hunks = change.diff?.hunks;
    if (!hunks || hunks.length === 0) continue;
    const aPath = change.status === "added" ? "/dev/null" : `a/${change.path}`;
    const bPath = change.status === "deleted" ? "/dev/null" : `b/${change.path}`;
    parts.push(`diff --git a/${change.path} b/${change.path}\n`);
    parts.push(`index 0000000..0000000 100644\n`);
    parts.push(`--- ${aPath}\n+++ ${bPath}\n`);
    for (const hunk of hunks) {
      parts.push(hunk.diff);
    }
  }
  return parts.join("");
}

async function getButStatus(cwd?: string): Promise<ButStatusJson> {
  const result = await runBut(["status", "-j"], cwd);
  if (result.exitCode !== 0) return {};
  try {
    return JSON.parse(result.stdout) as ButStatusJson;
  } catch {
    return {};
  }
}

async function butDiffChanges(target: string, cwd?: string): Promise<ButDiffEntry[]> {
  const result = await runBut(["diff", "-j", "--no-tui", target], cwd);
  if (result.exitCode !== 0) return [];
  try {
    return (JSON.parse(result.stdout) as ButDiffJson).changes ?? [];
  } catch {
    return [];
  }
}

export async function runGitButlerDiff(
  diffType: DiffType,
  cwd?: string,
): Promise<DiffResult> {
  const rawTarget =
    diffType === "gitbutler:workspace"
      ? null
      : (diffType as string).slice("gitbutler:".length);

  if (!rawTarget) {
    // Workspace: diff from merge base (includes committed lane changes + working tree changes)
    const status = await getButStatus(cwd);
    const mergeBase = status.mergeBase?.commitId;
    const ref = mergeBase ?? "HEAD";

    const trackedResult = await runGit(
      ["diff", "--no-ext-diff", ref, "--src-prefix=a/", "--dst-prefix=b/"],
      cwd,
    );
    if (trackedResult.exitCode !== 0) {
      const msg = trackedResult.stderr.split("\n").find((l) => l.trim()) ?? trackedResult.stderr;
      return { patch: "", label: "Workspace", error: msg.slice(0, 200) };
    }

    // git diff never includes untracked files — collect new files from but status
    const allChanges = [
      ...(status.unassignedChanges ?? []),
      ...(status.stacks ?? []).flatMap((s) => s.assignedChanges ?? []),
    ];
    const newFiles = allChanges
      .filter((c) => c.changeType === "added")
      .map((c) => c.filePath);

    // Committed files per individual branch (for accurate lane attribution)
    const committedByBranch = await Promise.all(
      (status.stacks ?? []).flatMap((stack) =>
        (stack.branches ?? [])
          .filter((b): b is ButBranch & { cliId: string; name: string } => Boolean(b.cliId && b.name))
          .map(async (branch) => {
            const changes = await butDiffChanges(branch.cliId, cwd);
            return { branchName: branch.name, paths: changes.map((c) => c.path) };
          })
      ),
    );

    const untrackedPatches = await Promise.all(
      newFiles.map((file) =>
        runGit(
          ["diff", "--no-ext-diff", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "/dev/null", file],
          cwd,
        ),
      ),
    );

    const patch = [trackedResult.stdout, ...untrackedPatches.map((r) => r.stdout)].join("");

    // Build fileMeta tracking per-lane source for accurate hover text
    const fileDetails = new Map<string, LaneDetail[]>();
    for (const c of status.unassignedChanges ?? []) {
      fileDetails.set(c.filePath, fileDetails.get(c.filePath) ?? []);
    }
    for (const stack of status.stacks ?? []) {
      const laneName = stack.branches?.[0]?.name ?? stack.cliId ?? "unknown";
      for (const c of stack.assignedChanges ?? []) {
        addLaneDetail(fileDetails, c.filePath, { lane: laneName, source: "uncommitted" });
      }
    }
    for (const { branchName, paths } of committedByBranch) {
      for (const p of paths) {
        addLaneDetail(fileDetails, p, { lane: branchName, source: "committed" });
      }
    }

    return { patch, label: "Workspace (all changes)", fileMeta: buildFileMeta(fileDetails) };
  }

  // Determine whether this is a per-stack or individual-branch diff
  const colonIdx = rawTarget.indexOf(":");
  const isIndividualBranch = colonIdx > -1;

  if (isIndividualBranch) {
    // Individual branch: gitbutler:{stackId}:{branchId} — show only that branch's commits
    const stackId = rawTarget.slice(0, colonIdx);
    const branchId = rawTarget.slice(colonIdx + 1);

    const status = await getButStatus(cwd);
    const stack = status.stacks?.find((s) => s.cliId === stackId);
    const branch = stack?.branches?.find((b) => b.cliId === branchId);
    const branchLabel = branch?.name ?? branchId;

    const committedChanges = await butDiffChanges(branchId, cwd);

    const fileMeta: Record<string, FileMetadata> = {};
    for (const c of committedChanges) fileMeta[c.path] = { source: "committed", lanes: [branchLabel] };

    return { patch: buildUnifiedPatch(committedChanges), label: branchLabel, fileMeta };
  }

  // Per-stack: combine uncommitted (stack) + committed (all branches) diffs for full picture
  const target = rawTarget;
  const status = await getButStatus(cwd);
  const stack = status.stacks?.find((s) => s.cliId === target);
  const branchCliIds = stack?.branches?.map((b) => b.cliId).filter((id): id is string => Boolean(id)) ?? [];

  const [uncommittedChanges, ...committedChangeSets] = await Promise.all([
    butDiffChanges(target, cwd),
    ...branchCliIds.map((id) => butDiffChanges(id, cwd)),
  ]);

  const allCommittedChanges = committedChangeSets.flat();
  const merged = mergeChanges(uncommittedChanges, allCommittedChanges);

  const branches = stack?.branches ?? [];
  const stackLabel = branches.length > 1
    ? `Stack: ${branches[0]?.name ?? target} (${branches.length})`
    : (branches[0]?.name ?? target);

  const branchNameById = new Map<string, string>(
    branches
      .filter((b): b is ButBranch & { cliId: string; name: string } => Boolean(b.cliId && b.name))
      .map((b) => [b.cliId, b.name])
  );

  const stackFileDetails = new Map<string, LaneDetail[]>();

  for (const c of uncommittedChanges) addLaneDetail(stackFileDetails, c.path, { lane: stackLabel, source: "uncommitted" });

  for (let i = 0; i < branchCliIds.length; i++) {
    const branchName = branchNameById.get(branchCliIds[i]) ?? branchCliIds[i];
    for (const c of committedChangeSets[i]) addLaneDetail(stackFileDetails, c.path, { lane: branchName, source: "committed" });
  }

  return { patch: buildUnifiedPatch(merged), label: stackLabel, fileMeta: buildFileMeta(stackFileDetails) };
}

// --- File contents ---

export async function getGitButlerFileContents(
  diffType: DiffType,
  _defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  // Per-lane: return null to avoid @pierre/diffs trailing context mismatch
  // (other lanes' hunks in the working tree shift line counts after the last hunk)
  if (diffType !== "gitbutler:workspace") {
    return { oldContent: null, newContent: null };
  }

  // Workspace: old = file at merge base (null for files added since), new = working tree
  const status = await getButStatus(cwd);
  const mergeBase = status.mergeBase?.commitId ?? "HEAD";
  const oldFilePath = oldPath ?? filePath;

  const [oldResult, newContent] = await Promise.all([
    runGit(["show", `${mergeBase}:${oldFilePath}`], cwd),
    Bun.file(cwd ? `${cwd}/${filePath}` : filePath)
      .text()
      .catch(() => null),
  ]);

  return {
    oldContent: oldResult.exitCode === 0 ? oldResult.stdout : null,
    newContent,
  };
}
