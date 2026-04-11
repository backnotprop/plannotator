import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import type { DiffType, GitContext } from "./vcs";
import { getVcsContext, runVcsDiff, validateFilePath } from "./vcs";
import { fetchPR, parsePRUrl, type PRMetadata } from "./pr";
import type {
  WorkspacePRCandidate,
  WorkspaceRepoSource,
  WorkspaceRepoState,
} from "@plannotator/shared/review-workspace";
import { resolveDefaultDiffType, loadConfig } from "@plannotator/shared/config";
import { parseRemoteUrl } from "@plannotator/shared/repo";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".turbo",
  ".next",
  "dist",
  "build",
  "coverage",
]);

export interface WorkspaceRepoRuntimeState extends WorkspaceRepoState {
  rawPatch: string;
  gitRef: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function prefixRepoPath(label: string, filePath: string): string {
  const normalizedFilePath = normalizePath(filePath);
  if (normalizedFilePath === "/dev/null") return normalizedFilePath;
  return `${normalizePath(label)}/${normalizedFilePath}`;
}

function rewritePatchLine(line: string, label: string): string {
  if (line.startsWith("diff --git a/")) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!match) return line;
    return `diff --git a/${prefixRepoPath(label, match[1])} b/${prefixRepoPath(label, match[2])}`;
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

  return line;
}

export function prefixPatchPaths(rawPatch: string, label: string): string {
  if (!rawPatch.trim()) return rawPatch;
  return rawPatch
    .split("\n")
    .map((line) => rewritePatchLine(line, label))
    .join("\n");
}

export function resolveWorkspaceFilePath(
  repos: WorkspaceRepoRuntimeState[],
  prefixedPath: string,
): { repo: WorkspaceRepoRuntimeState; repoRelativePath: string } | null {
  validateFilePath(prefixedPath);

  for (const repo of [...repos].sort((a, b) => b.label.length - a.label.length)) {
    const prefix = `${normalizePath(repo.label)}/`;
    if (prefixedPath.startsWith(prefix)) {
      return {
        repo,
        repoRelativePath: prefixedPath.slice(prefix.length),
      };
    }
  }

  return null;
}

function hasGitMarker(dirPath: string): boolean {
  return existsSync(resolve(dirPath, ".git"));
}

function collectGitRepos(root: string, current: string, results: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
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

function buildRepoLabel(root: string, cwd: string, used = new Set<string>()): string {
  const rel = normalizePath(relative(root, cwd));
  const preferred = rel && rel !== "" ? rel : basename(cwd);
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }

  const fallback = normalizePath(basename(cwd));
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

function buildUniqueLabel(preferred: string, used = new Set<string>()): string {
  const normalized = normalizePath(preferred);
  if (!used.has(normalized)) {
    used.add(normalized);
    return normalized;
  }

  let counter = 2;
  let next = `${normalized}-${counter}`;
  while (used.has(next)) {
    counter += 1;
    next = `${normalized}-${counter}`;
  }
  used.add(next);
  return next;
}

async function discoverGitHubPRCandidate(cwd: string, gitContext: GitContext): Promise<WorkspacePRCandidate | null> {
  const branch = gitContext.currentBranch;
  if (!branch || branch === "HEAD") return null;

  const remoteProc = Bun.spawn(["git", "remote", "get-url", "origin"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [remoteUrl, remoteCode] = await Promise.all([
    new Response(remoteProc.stdout).text(),
    remoteProc.exited,
  ]);
  if (remoteCode !== 0) return null;

  const repo = parseRemoteUrl(remoteUrl.trim());
  if (!repo) return null;

  const hostMatch = remoteUrl.trim().match(/^[^@]+@([^:]+):/)?.[1];
  const httpsHost = (() => {
    try {
      return new URL(remoteUrl.trim()).hostname;
    } catch {
      return null;
    }
  })();
  const host = hostMatch || httpsHost || "github.com";

  const ghArgs = [
    "pr",
    "list",
    "--state",
    "open",
    "--head",
    branch,
    "--json",
    "url",
    "--limit",
    "1",
  ];
  const env = host === "github.com" ? process.env : { ...process.env, GH_HOST: host };
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["gh", ...ghArgs], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;

  let entries: Array<{ url?: string }>;
  try {
    entries = JSON.parse(stdout);
  } catch {
    return null;
  }

  const url = entries[0]?.url;
  if (!url) return null;
  const ref = parsePRUrl(url);
  if (!ref) return null;

  try {
    const pr = await fetchPR(ref);
    return { url, metadata: pr.metadata };
  } catch {
    return null;
  }
}

async function discoverGitLabPRCandidate(cwd: string, gitContext: GitContext): Promise<WorkspacePRCandidate | null> {
  const branch = gitContext.currentBranch;
  if (!branch || branch === "HEAD") return null;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([
      "glab",
      "mr",
      "list",
      "--source-branch",
      branch,
      "--state",
      "opened",
      "--output",
      "json",
    ], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) return null;

  let entries: Array<{ web_url?: string }>;
  try {
    entries = JSON.parse(stdout);
  } catch {
    return null;
  }

  const url = entries[0]?.web_url;
  if (!url) return null;
  const ref = parsePRUrl(url);
  if (!ref) return null;

  try {
    const pr = await fetchPR(ref);
    return { url, metadata: pr.metadata };
  } catch {
    return null;
  }
}

export async function discoverPRCandidates(cwd: string, gitContext: GitContext): Promise<WorkspacePRCandidate[]> {
  const candidates = await Promise.all([
    discoverGitHubPRCandidate(cwd, gitContext),
    discoverGitLabPRCandidate(cwd, gitContext),
  ]);

  return candidates.filter((candidate): candidate is WorkspacePRCandidate => !!candidate);
}

export async function buildWorkspaceLocalRepos(root: string): Promise<WorkspaceRepoRuntimeState[]> {
  const repoPaths = discoverWorkspaceRepoPaths(root);
  const defaultDiffType = resolveDefaultDiffType(loadConfig());
  const usedLabels = new Set<string>();

  const repos = await Promise.all(repoPaths.map(async (cwd, index) => {
    const label = buildRepoLabel(root, cwd, usedLabels);
    try {
      const gitContext = await getVcsContext(cwd);
      const diffType = gitContext.vcsType === "p4" ? "p4-default" : defaultDiffType;
      const diffResult = await runVcsDiff(diffType, gitContext.defaultBranch, cwd);
      const discoveredPRs = await discoverPRCandidates(cwd, gitContext);
      return {
        id: `repo-${index + 1}`,
        label,
        cwd,
        selected: !!diffResult.patch.trim(),
        source: "local" as WorkspaceRepoSource,
        diffType,
        gitContext,
        diffOptions: gitContext.diffOptions,
        discoveredPRs,
        rawPatch: prefixPatchPaths(diffResult.patch, label),
        gitRef: diffResult.label,
        error: diffResult.error,
      } satisfies WorkspaceRepoRuntimeState;
    } catch (error) {
      return {
        id: `repo-${index + 1}`,
        label,
        cwd,
        selected: false,
        source: "local" as WorkspaceRepoSource,
        rawPatch: "",
        gitRef: "",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkspaceRepoRuntimeState;
    }
  }));

  return repos;
}

export async function buildWorkspacePRRepos(urls: string[]): Promise<WorkspaceRepoRuntimeState[]> {
  const usedLabels = new Set<string>();
  const repos = await Promise.all(urls.map(async (url, index) => {
    const ref = parsePRUrl(url);
    if (!ref) {
      return {
        id: `repo-${index + 1}`,
        label: `invalid-${index + 1}`,
        cwd: process.cwd(),
        selected: false,
        source: "pr" as WorkspaceRepoSource,
        rawPatch: "",
        gitRef: "",
        error: `Invalid PR/MR URL: ${url}`,
      } satisfies WorkspaceRepoRuntimeState;
    }

    try {
      const pr = await fetchPR(ref);
      const baseLabel = pr.metadata.platform === "github"
        ? `${pr.metadata.owner}/${pr.metadata.repo}`
        : pr.metadata.projectPath;
      const label = buildUniqueLabel(baseLabel, usedLabels);
      return {
        id: `repo-${index + 1}`,
        label,
        cwd: process.cwd(),
        selected: true,
        source: "pr" as WorkspaceRepoSource,
        prMetadata: pr.metadata,
        rawPatch: prefixPatchPaths(pr.rawPatch, label),
        gitRef: pr.metadata.url,
      } satisfies WorkspaceRepoRuntimeState;
    } catch (error) {
      return {
        id: `repo-${index + 1}`,
        label: `pr-${index + 1}`,
        cwd: process.cwd(),
        selected: false,
        source: "pr" as WorkspaceRepoSource,
        rawPatch: "",
        gitRef: "",
        error: error instanceof Error ? error.message : String(error),
      } satisfies WorkspaceRepoRuntimeState;
    }
  }));

  return repos;
}

export function aggregateWorkspacePatch(repos: WorkspaceRepoRuntimeState[]): {
  rawPatch: string;
  gitRef: string;
  errors: string[];
} {
  const selected = repos.filter((repo) => repo.selected);
  return {
    rawPatch: selected.map((repo) => repo.rawPatch.trim()).filter(Boolean).join("\n"),
    gitRef: selected.map((repo) => repo.gitRef || repo.label).filter(Boolean).join(" | ") || "Workspace review",
    errors: selected.flatMap((repo) => repo.error ? [`${repo.label}: ${repo.error}`] : []),
  };
}
