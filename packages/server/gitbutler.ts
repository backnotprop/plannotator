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
  type FileMeta,
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["but", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
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
        // Use the topmost branch name as the display label for the stack
        const label = stack.branches?.[0]?.name ?? stack.cliId;
        virtualBranches.push({ id: stack.cliId, name: label });
        diffOptions.push({ id: `gitbutler:${stack.cliId}`, label });
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
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
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
  const target =
    diffType === "gitbutler:workspace"
      ? null
      : (diffType as string).slice("gitbutler:".length);

  if (!target) {
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

    // Committed files per branch (for lane attribution)
    const committedByLane = await Promise.all(
      (status.stacks ?? []).map(async (stack) => {
        const laneName = stack.branches?.[0]?.name ?? stack.cliId ?? "unknown";
        const committed = (
          await Promise.all((stack.branches ?? []).map((b) => b.cliId ? butDiffChanges(b.cliId, cwd) : Promise.resolve([])))
        ).flat();
        return { laneName, paths: committed.map((c) => c.path) };
      }),
    );

    const [untrackedPatches] = await Promise.all([
      Promise.all(
        newFiles.map((file) =>
          runGit(
            ["diff", "--no-ext-diff", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", "/dev/null", file],
            cwd,
          ),
        ),
      ),
    ]);

    const patch = [trackedResult.stdout, ...untrackedPatches.map((r) => r.stdout)].join("");

    // Build fileMeta tracking per-lane source for accurate hover text
    type LaneDetail = { lane: string; source: "committed" | "uncommitted" };
    const fileDetails = new Map<string, LaneDetail[]>();
    const addDetail = (filePath: string, detail: LaneDetail) => {
      const arr = fileDetails.get(filePath) ?? [];
      // Deduplicate by lane+source key
      if (!arr.some((d) => d.lane === detail.lane && d.source === detail.source)) {
        arr.push(detail);
      }
      fileDetails.set(filePath, arr);
    };
    for (const c of status.unassignedChanges ?? []) {
      fileDetails.set(c.filePath, fileDetails.get(c.filePath) ?? []);
    }
    for (const stack of status.stacks ?? []) {
      const laneName = stack.branches?.[0]?.name ?? stack.cliId ?? "unknown";
      for (const c of stack.assignedChanges ?? []) {
        addDetail(c.filePath, { lane: laneName, source: "uncommitted" });
      }
    }
    for (const { laneName, paths } of committedByLane) {
      for (const p of paths) {
        addDetail(p, { lane: laneName, source: "committed" });
      }
    }
    const fileMeta: Record<string, FileMeta> = {};
    for (const [filePath, details] of fileDetails) {
      if (details.length === 0) { fileMeta[filePath] = {}; continue; }
      const lanes = [...new Set(details.map((d) => d.lane))];
      const sources = [...new Set(details.map((d) => d.source))];
      const source: FileMeta["source"] =
        sources.length === 1 ? (sources[0] as "committed" | "uncommitted") : "mixed";
      const base = lanes.length === 1
        ? { source, lane: lanes[0] }
        : { source, lanes };
      fileMeta[filePath] = lanes.length > 1 ? { ...base, laneDetails: details } : base;
    }

    return { patch, label: "Workspace (all changes)", fileMeta };
  }

  // Per-lane: combine uncommitted (stack) + committed (branch) diffs for full picture
  const status = await getButStatus(cwd);
  const stack = status.stacks?.find((s) => s.cliId === target);
  const branchCliIds = stack?.branches?.map((b) => b.cliId).filter(Boolean) as string[] ?? [];

  const [uncommittedChanges, ...committedChangeSets] = await Promise.all([
    butDiffChanges(target, cwd),
    ...branchCliIds.map((id) => butDiffChanges(id, cwd)),
  ]);

  const allCommittedChanges = committedChangeSets.flat();
  const merged = mergeChanges(uncommittedChanges, allCommittedChanges);

  const stackLabel = stack?.branches?.[0]?.name ?? target;
  const fileMeta: Record<string, FileMeta> = {};
  for (const c of uncommittedChanges) fileMeta[c.path] = { source: "uncommitted", lane: stackLabel };
  for (const c of allCommittedChanges) {
    fileMeta[c.path] = fileMeta[c.path]
      ? { source: "mixed", lane: stackLabel }
      : { source: "committed", lane: stackLabel };
  }

  return { patch: buildUnifiedPatch(merged), label: stackLabel, fileMeta };
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
