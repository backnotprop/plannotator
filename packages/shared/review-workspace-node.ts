import { existsSync, readdirSync, type Dirent } from "node:fs";
import { basename, relative, resolve } from "node:path";

import {
  formatDiffMetadataPathToken,
  formatPatchPathToken,
  parseDiffFilePathLines,
  parseDiffGitHeader,
  parseDiffMetadataPathLines,
  parseDiffMetadataPathToken,
  parsePatchPathToken,
} from "./diff-paths";
import { validateFilePath } from "./review-core";

const SKIP_DIRS = new Set([
  ".git",
  ".jj",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
]);

const VCS_MARKERS = [".jj", ".git"] as const;

export interface WorkspacePathEntry {
  label: string;
}

export interface WorkspacePatchEntry {
  label: string;
  selected: boolean;
  rawPatch: string;
  gitRef?: string;
  error?: string;
}

export interface WorkspacePathResolution<T extends WorkspacePathEntry> {
  repo: T;
  repoRelativePath: string;
}

export interface WorkspacePatchAggregate {
  rawPatch: string;
  gitRef: string;
  errors: string[];
}

export function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function prefixRepoPath(label: string, filePath: string): string {
  if (filePath === "/dev/null") return filePath;
  const normalizedFilePath = normalizeWorkspacePath(filePath);
  return `${normalizeWorkspacePath(label)}/${normalizedFilePath}`;
}

function rewritePatchLine(line: string, label: string): string {
  if (line.startsWith("--- ")) {
    const parsed = parsePatchPathToken(line.slice(4), "a");
    if (parsed === "/dev/null") return line;
    if (parsed) return `--- ${formatPatchPathToken("a", prefixRepoPath(label, parsed))}`;
    return line;
  }

  if (line.startsWith("+++ ")) {
    const parsed = parsePatchPathToken(line.slice(4), "b");
    if (parsed === "/dev/null") return line;
    if (parsed) return `+++ ${formatPatchPathToken("b", prefixRepoPath(label, parsed))}`;
    return line;
  }

  if (line.startsWith("rename from ")) {
    const parsed = parseDiffMetadataPathToken(line.slice("rename from ".length));
    if (parsed === "/dev/null") return line;
    return `rename from ${formatDiffMetadataPathToken(prefixRepoPath(label, parsed))}`;
  }
  if (line.startsWith("rename to ")) {
    const parsed = parseDiffMetadataPathToken(line.slice("rename to ".length));
    if (parsed === "/dev/null") return line;
    return `rename to ${formatDiffMetadataPathToken(prefixRepoPath(label, parsed))}`;
  }
  if (line.startsWith("copy from ")) {
    const parsed = parseDiffMetadataPathToken(line.slice("copy from ".length));
    if (parsed === "/dev/null") return line;
    return `copy from ${formatDiffMetadataPathToken(prefixRepoPath(label, parsed))}`;
  }
  if (line.startsWith("copy to ")) {
    const parsed = parseDiffMetadataPathToken(line.slice("copy to ".length));
    if (parsed === "/dev/null") return line;
    return `copy to ${formatDiffMetadataPathToken(prefixRepoPath(label, parsed))}`;
  }

  return line;
}

function rewritePatchChunk(chunk: string, label: string): string {
  const lines = chunk.split("\n");
  const fromFileLines = parseDiffFilePathLines(lines);
  const fromMetadata = parseDiffMetadataPathLines(lines);
  const fromHeader = parseDiffGitHeader(lines[0] ?? "");
  const oldPath = fromFileLines.oldPath ?? fromMetadata.oldPath ?? fromHeader.oldPath;
  const newPath = fromFileLines.newPath ?? fromMetadata.newPath ?? fromHeader.newPath;
  const headerOldPath = oldPath ?? newPath;
  const headerNewPath = newPath ?? oldPath;

  if (lines[0]?.startsWith("diff --git ") && headerOldPath && headerNewPath) {
    const prefixedOld = prefixRepoPath(label, headerOldPath);
    const prefixedNew = prefixRepoPath(label, headerNewPath);
    lines[0] = `diff --git ${formatPatchPathToken("a", prefixedOld)} ${formatPatchPathToken("b", prefixedNew)}`;
  }

  return lines.map((line, index) => index === 0 ? line : rewritePatchLine(line, label)).join("\n");
}

export function prefixWorkspacePatchPaths(rawPatch: string, label: string): string {
  if (!rawPatch.trim()) return rawPatch;
  if (!rawPatch.includes("diff --git ")) {
    return rawPatch
      .split("\n")
      .map((line) => rewritePatchLine(line, label))
      .join("\n");
  }

  const chunks = rawPatch.split(/^diff --git /m);
  const prefix = chunks.shift() ?? "";
  return prefix + chunks.map((chunk) => rewritePatchChunk(`diff --git ${chunk}`, label)).join("");
}

export function resolveWorkspaceFilePath<T extends WorkspacePathEntry>(
  repos: T[],
  prefixedPath: string,
): WorkspacePathResolution<T> | null {
  const normalizedPath = normalizeWorkspacePath(prefixedPath);
  validateFilePath(normalizedPath);

  const sorted = [...repos].sort((a, b) => b.label.length - a.label.length);

  for (const repo of sorted) {
    const label = normalizeWorkspacePath(repo.label);
    const prefix = `${label}/`;
    if (normalizedPath.startsWith(prefix)) {
      const repoRelativePath = normalizedPath.slice(prefix.length);
      if (!repoRelativePath) return null;
      return {
        repo,
        repoRelativePath,
      };
    }
  }

  return null;
}

function hasVcsMarker(dirPath: string): boolean {
  return VCS_MARKERS.some((marker) => existsSync(resolve(dirPath, marker)));
}

function collectWorkspaceRepos(root: string, current: string, results: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  if (current !== root && hasVcsMarker(current)) {
    results.push(current);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    collectWorkspaceRepos(root, resolve(current, entry.name), results);
  }
}

export function discoverWorkspaceRepoPaths(root: string): string[] {
  const resolvedRoot = resolve(root);
  const results: string[] = [];
  collectWorkspaceRepos(resolvedRoot, resolvedRoot, results);
  return results.sort();
}

function buildRepoLabel(root: string, cwd: string, used: Set<string>): string {
  const rel = normalizeWorkspacePath(relative(root, cwd));
  const preferred = rel && rel !== "" ? rel : basename(cwd);
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }

  const fallback = normalizeWorkspacePath(basename(cwd));
  if (!used.has(fallback)) {
    used.add(fallback);
    return fallback;
  }

  let counter = 2;
  let next = `${fallback}-${counter}`;
  while (used.has(next)) {
    counter += 1;
    next = `${fallback}-${counter}`;
  }
  used.add(next);
  return next;
}

export function buildWorkspaceRepoLabels(root: string, repoPaths: string[]): string[] {
  const resolvedRoot = resolve(root);
  const usedLabels = new Set<string>();
  return repoPaths.map((cwd) => buildRepoLabel(resolvedRoot, cwd, usedLabels));
}

export function aggregateWorkspacePatch(repos: WorkspacePatchEntry[]): WorkspacePatchAggregate {
  const selected = repos.filter((repo) => repo.selected);
  const trimmedPatches = selected
    .map((repo) => repo.rawPatch)
    .filter((patch) => patch.trim().length > 0)
    .map((patch) => patch.replace(/\n+$/, ""));
  return {
    rawPatch: trimmedPatches.join("\n\n"),
    gitRef: selected.map((repo) => repo.gitRef || repo.label).filter(Boolean).join(" | ") || "Workspace review",
    errors: repos.flatMap((repo) => repo.error ? [`${repo.label}: ${repo.error}`] : []),
  };
}
