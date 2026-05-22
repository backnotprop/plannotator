import { existsSync, readdirSync, type Dirent } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { validateFilePath } from "./review-core";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
]);

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
  const normalizedFilePath = normalizeWorkspacePath(filePath);
  if (normalizedFilePath === "/dev/null") return normalizedFilePath;
  return `${normalizeWorkspacePath(label)}/${normalizedFilePath}`;
}

function rewritePatchLine(line: string, label: string): string {
  if (line.startsWith("diff --git a/") || line.startsWith('diff --git "a/')) {
    const match = line.match(/^diff --git (?:"?a\/(.+?)"?|\/?a\/(.+?)) (?:"?b\/(.+?)"?|\/?b\/(.+?))$/);
    if (!match) return line;
    const oldPath = match[1] ?? match[2];
    const newPath = match[3] ?? match[4];
    return `diff --git a/${prefixRepoPath(label, oldPath)} b/${prefixRepoPath(label, newPath)}`;
  }

  if (line.startsWith("--- ")) {
    const path = line.slice(4);
    if (path === "/dev/null") return line;
    if (path.startsWith("a/")) return `--- a/${prefixRepoPath(label, path.slice(2))}`;
    return line;
  }

  if (line.startsWith("+++ ")) {
    const path = line.slice(4);
    if (path === "/dev/null") return line;
    if (path.startsWith("b/")) return `+++ b/${prefixRepoPath(label, path.slice(2))}`;
    return line;
  }

  if (line.startsWith("rename from ")) {
    return `rename from ${prefixRepoPath(label, line.slice("rename from ".length))}`;
  }
  if (line.startsWith("rename to ")) {
    return `rename to ${prefixRepoPath(label, line.slice("rename to ".length))}`;
  }
  if (line.startsWith("copy from ")) {
    return `copy from ${prefixRepoPath(label, line.slice("copy from ".length))}`;
  }
  if (line.startsWith("copy to ")) {
    return `copy to ${prefixRepoPath(label, line.slice("copy to ".length))}`;
  }

  return line;
}

export function prefixWorkspacePatchPaths(rawPatch: string, label: string): string {
  if (!rawPatch.trim()) return rawPatch;
  return rawPatch
    .split("\n")
    .map((line) => rewritePatchLine(line, label))
    .join("\n");
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
    if (normalizedPath === label || normalizedPath.startsWith(prefix)) {
      return {
        repo,
        repoRelativePath: normalizedPath.slice(prefix.length),
      };
    }
  }

  return null;
}

function hasGitMarker(dirPath: string): boolean {
  return existsSync(resolve(dirPath, ".git"));
}

function collectGitRepos(root: string, current: string, results: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }

  if (current !== root && hasGitMarker(current)) {
    results.push(current);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    collectGitRepos(root, resolve(current, entry.name), results);
  }
}

export function discoverWorkspaceRepoPaths(root: string): string[] {
  const resolvedRoot = resolve(root);
  const results: string[] = [];
  collectGitRepos(resolvedRoot, resolvedRoot, results);
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
  const trimmedPatches = selected.map((repo) => repo.rawPatch.trim()).filter(Boolean);
  return {
    rawPatch: trimmedPatches.join("\n\n"),
    gitRef: selected.map((repo) => repo.gitRef || repo.label).filter(Boolean).join(" | ") || "Workspace review",
    errors: repos.flatMap((repo) => repo.error ? [`${repo.label}: ${repo.error}`] : []),
  };
}
