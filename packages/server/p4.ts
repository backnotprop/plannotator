/**
 * Perforce (P4) utilities for code review
 *
 * Provides pending changelist diff support for Perforce workspaces.
 * Mirrors the structure of git.ts for consistent VCS abstraction.
 */

import {
  type DiffResult,
  type DiffType,
  type GitCommandResult,
  type GitContext,
  parseP4DiffType,
  validateFilePath,
} from "@plannotator/shared/review-core";

// --- P4 command runner ---

async function runP4(
  args: string[],
  options?: { cwd?: string },
): Promise<GitCommandResult> {
  const proc = Bun.spawn(["p4", ...args], {
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
}

// --- Path helpers ---

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function toRelativePath(absPath: string, normalizedRoot: string): string {
  const normalized = normalizePath(absPath);
  if (normalized.startsWith(normalizedRoot + "/")) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  if (normalized.startsWith(normalizedRoot)) {
    return normalized.slice(normalizedRoot.length);
  }
  return normalized;
}

// --- P4 workspace detection (cached) ---

export interface P4WorkspaceInfo {
  clientName: string;
  clientRoot: string;
  /** clientRoot with backslashes normalized to forward slashes */
  normalizedRoot: string;
  userName: string;
  serverAddress: string;
}

const workspaceCache = new Map<string, { info: P4WorkspaceInfo | null; ts: number }>();
const CACHE_TTL_MS = 30_000;

export async function detectP4Workspace(
  cwd?: string,
): Promise<P4WorkspaceInfo | null> {
  const key = cwd ?? process.cwd();
  const cached = workspaceCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.info;
  }

  const result = await runP4(["info"], { cwd });
  if (result.exitCode !== 0) {
    workspaceCache.set(key, { info: null, ts: Date.now() });
    return null;
  }

  const info: Record<string, string> = {};
  for (const line of result.stdout.split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx !== -1) {
      info[line.slice(0, colonIdx).trim()] = line.slice(colonIdx + 2).trim();
    }
  }

  const clientName = info["Client name"];
  const clientRoot = info["Client root"];
  const userName = info["User name"];
  const serverAddress = info["Server address"];

  if (!clientName || !clientRoot) {
    workspaceCache.set(key, { info: null, ts: Date.now() });
    return null;
  }

  const wsInfo: P4WorkspaceInfo = {
    clientName,
    clientRoot,
    normalizedRoot: normalizePath(clientRoot).replace(/\/$/, ""),
    userName,
    serverAddress,
  };
  workspaceCache.set(key, { info: wsInfo, ts: Date.now() });
  return wsInfo;
}

// --- P4 context (GitContext compatible) ---

export async function getP4Context(cwd?: string): Promise<GitContext> {
  const workspace = await detectP4Workspace(cwd);
  if (!workspace) {
    return {
      currentBranch: "",
      defaultBranch: "",
      diffOptions: [],
      worktrees: [],
      cwd,
      vcsType: "p4",
    };
  }

  const diffOptions: GitContext["diffOptions"] = [];

  // Check default changelist has files
  const [defaultOpened, changesResult] = await Promise.all([
    runP4(["opened", "-c", "default"], { cwd }),
    runP4(["changes", "-s", "pending", "-u", workspace.userName, "-c", workspace.clientName], { cwd }),
  ]);

  if (defaultOpened.exitCode === 0 && defaultOpened.stdout.trim()) {
    diffOptions.push({ id: "p4-default", label: "Default changelist" });
  }

  // Collect numbered changelists, then check which have files
  if (changesResult.exitCode === 0) {
    const candidates: { clNumber: string; desc: string }[] = [];
    for (const line of changesResult.stdout.trim().split("\n")) {
      if (!line) continue;
      const match = line.match(/^Change (\d+) on .+? by .+? \*?'(.*)'\s*$/);
      if (match) {
        const desc = match[2].length > 40 ? match[2].slice(0, 40) + "..." : match[2];
        candidates.push({ clNumber: match[1], desc });
      }
    }

    // Check all changelists for opened files in parallel
    const checks = await Promise.all(
      candidates.map(({ clNumber }) => runP4(["opened", "-c", clNumber], { cwd })),
    );

    for (let i = 0; i < candidates.length; i++) {
      if (checks[i].exitCode === 0 && checks[i].stdout.trim()) {
        diffOptions.push({
          id: `p4-changelist:${candidates[i].clNumber}`,
          label: `CL ${candidates[i].clNumber}: ${candidates[i].desc}`,
        });
      }
    }
  }

  return {
    currentBranch: workspace.clientName,
    defaultBranch: "",
    diffOptions,
    worktrees: [],
    cwd: cwd ?? workspace.clientRoot,
    vcsType: "p4",
  };
}

// --- P4 diff ---

/**
 * Convert P4 diff output to git-compatible unified diff format.
 *
 * P4 `diff -du` outputs:
 *   --- //depot/path/file.cpp\tdate
 *   +++ C:\Workspace\client\path\file.cpp\tdate
 *   @@ hunks @@
 *
 * Converted to:
 *   diff --git a/relative/file.cpp b/relative/file.cpp
 *   --- a/relative/file.cpp
 *   +++ b/relative/file.cpp
 *   @@ hunks @@
 */
function convertP4DiffToGitFormat(
  rawOutput: string,
  normalizedRoot: string,
): string {
  const lines = rawOutput.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match ==== separator (some P4 versions use this)
    const separatorMatch = line.match(/^==== .+#\d+ - (.+?) ====/);
    if (separatorMatch) {
      const relativePath = toRelativePath(separatorMatch[1], normalizedRoot);
      result.push(`diff --git a/${relativePath} b/${relativePath}`);
      continue;
    }

    // Match --- line: starts a new file diff
    if (line.startsWith("--- ") && !line.startsWith("--- a/")) {
      // Determine relative path from +++ line (local path, more reliable)
      const nextLine = lines[i + 1];
      let relativePath: string;
      if (nextLine && nextLine.startsWith("+++ ")) {
        const localPath = nextLine.slice(4).split("\t")[0];
        relativePath = toRelativePath(localPath, normalizedRoot);
      } else {
        const rawPath = line.slice(4).split("\t")[0];
        relativePath = toRelativePath(rawPath, normalizedRoot);
      }

      result.push(`diff --git a/${relativePath} b/${relativePath}`);
      result.push(`--- a/${relativePath}`);
      continue;
    }

    if (line.startsWith("+++ ") && !line.startsWith("+++ b/")) {
      const localPath = line.slice(4).split("\t")[0];
      const relativePath = toRelativePath(localPath, normalizedRoot);
      result.push(`+++ b/${relativePath}`);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Get unified diff for new files (p4 add) that have no depot version yet.
 */
async function getNewFileDiff(
  localPath: string,
  relativePath: string,
): Promise<string> {
  try {
    const content = await Bun.file(localPath).text();
    const lines = content.split("\n");
    const header = [
      `diff --git a/${relativePath} b/${relativePath}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${relativePath}`,
      `@@ -0,0 +1,${lines.length} @@`,
    ];
    return header.join("\n") + "\n" + lines.map((l) => `+${l}`).join("\n");
  } catch {
    return "";
  }
}

/**
 * Batch-resolve depot paths to local paths via a single `p4 where` call.
 * Returns a map from depot path to { localPath, relativePath }.
 */
async function batchResolveDepotPaths(
  depotPaths: string[],
  normalizedRoot: string,
  cwd?: string,
): Promise<Map<string, { localPath: string; relativePath: string }>> {
  const result = new Map<string, { localPath: string; relativePath: string }>();
  if (depotPaths.length === 0) return result;

  const whereResult = await runP4(["where", ...depotPaths], { cwd });
  if (whereResult.exitCode !== 0) return result;

  const outputLines = whereResult.stdout.trim().split("\n");
  for (let i = 0; i < outputLines.length && i < depotPaths.length; i++) {
    const whereOutput = outputLines[i];
    const rootIdx = whereOutput.indexOf(normalizePath(normalizedRoot).length > 0 ? normalizedRoot : "NOMATCH");
    // Find the local path by looking for the client root
    const clientRootBackslash = normalizedRoot.replace(/\//g, "\\");
    const bsIdx = whereOutput.indexOf(clientRootBackslash);
    const fwIdx = whereOutput.indexOf(normalizedRoot);
    const idx = bsIdx !== -1 ? bsIdx : fwIdx;
    if (idx === -1) continue;

    const localPath = normalizePath(whereOutput.slice(idx));
    const relativePath = toRelativePath(localPath, normalizedRoot);
    result.set(depotPaths[i], { localPath, relativePath });
  }

  return result;
}

export async function runP4Diff(
  diffType: DiffType,
  cwd?: string,
): Promise<DiffResult> {
  const workspace = await detectP4Workspace(cwd);
  if (!workspace) {
    return { patch: "", label: "P4 error", error: "Not in a Perforce workspace" };
  }

  const parsed = parseP4DiffType(diffType);
  if (!parsed) {
    return { patch: "", label: "Unknown diff type" };
  }

  try {
    const label = parsed.changelist === "default"
      ? "Default changelist"
      : `Changelist ${parsed.changelist}`;

    const openedArgs = parsed.changelist === "default"
      ? ["opened", "-c", "default"]
      : ["opened", "-c", parsed.changelist];
    const openedResult = await runP4(openedArgs, { cwd });

    if (openedResult.exitCode !== 0 || !openedResult.stdout.trim()) {
      return { patch: "", label, error: openedResult.stderr || undefined };
    }

    const diffDepotPaths: string[] = [];
    const addedDepotPaths: string[] = [];

    for (const line of openedResult.stdout.trim().split("\n")) {
      if (!line) continue;
      // Skip binary files — type in parentheses, e.g. "(binary)", "(binary+l)"
      const typeMatch = line.match(/\((\S+)\)\s*(by\s|$)/);
      if (typeMatch && typeMatch[1].startsWith("binary")) continue;
      const depotPath = line.split("#")[0];
      if (!depotPath) continue;
      if (line.includes(" - add ")) {
        addedDepotPaths.push(depotPath);
      } else {
        diffDepotPaths.push(depotPath);
      }
    }

    let patch = "";

    if (diffDepotPaths.length > 0) {
      const diffResult = await runP4(["diff", "-du", ...diffDepotPaths], { cwd });
      if (diffResult.exitCode === 0 || diffResult.stdout.trim()) {
        patch = convertP4DiffToGitFormat(diffResult.stdout, workspace.normalizedRoot);
      }
    }

    // Handle newly added files (p4 add) — they don't appear in p4 diff
    if (addedDepotPaths.length > 0) {
      const resolved = await batchResolveDepotPaths(addedDepotPaths, workspace.normalizedRoot, cwd);
      for (const depotPath of addedDepotPaths) {
        const mapping = resolved.get(depotPath);
        if (!mapping) continue;
        const newFilePatch = await getNewFileDiff(mapping.localPath, mapping.relativePath);
        if (newFilePatch) {
          patch += (patch ? "\n" : "") + newFilePatch;
        }
      }
    }

    return { patch, label };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { patch: "", label: "P4 error", error: message };
  }
}

// --- File content retrieval ---

export async function getP4FileContentsForDiff(
  diffType: DiffType,
  filePath: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  const workspace = await detectP4Workspace(cwd);
  if (!workspace) return { oldContent: null, newContent: null };

  validateFilePath(filePath);

  const fullLocalPath = `${workspace.normalizedRoot}/${filePath}`;

  const [printResult, newContent] = await Promise.all([
    runP4(["print", "-q", `${fullLocalPath}#have`], { cwd }),
    Bun.file(fullLocalPath).text().catch(() => null),
  ]);

  return {
    oldContent: printResult.exitCode === 0 ? printResult.stdout : null,
    newContent,
  };
}
