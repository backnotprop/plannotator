import type { DaemonProjectEntry } from "@plannotator/shared/daemon-protocol";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { join, resolve, dirname } from "path";

export interface ProjectRegistryOptions {
  baseDir?: string;
}

function registryPath(options: ProjectRegistryOptions = {}): string {
  const dir = options.baseDir ?? join(homedir(), ".plannotator");
  return join(dir, "projects.json");
}

function isProjectEntry(value: unknown): value is DaemonProjectEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.cwd === "string" &&
    typeof v.lastSeen === "string"
  );
}

export function readProjectRegistry(options: ProjectRegistryOptions = {}): DaemonProjectEntry[] {
  const path = registryPath(options);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProjectEntry);
  } catch {
    return [];
  }
}

export function writeProjectRegistry(
  entries: DaemonProjectEntry[],
  options: ProjectRegistryOptions = {},
): void {
  const path = registryPath(options);
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

export function registerProject(
  name: string,
  cwd: string,
  options: ProjectRegistryOptions = {},
): DaemonProjectEntry {
  const entries = readProjectRegistry(options);
  const now = new Date().toISOString();
  const existing = entries.find((e) => e.cwd === cwd);
  if (existing) {
    existing.name = name;
    existing.lastSeen = now;
    writeProjectRegistry(entries, options);
    return existing;
  }
  const entry: DaemonProjectEntry = { name, cwd, lastSeen: now };
  entries.push(entry);
  writeProjectRegistry(entries, options);
  return entry;
}

export function removeProject(
  cwd: string,
  options: ProjectRegistryOptions = {},
): boolean {
  const entries = readProjectRegistry(options);
  const filtered = entries.filter((e) => e.cwd !== cwd);
  if (filtered.length === entries.length) return false;
  writeProjectRegistry(filtered, options);
  return true;
}

export function listProjects(options: ProjectRegistryOptions = {}): DaemonProjectEntry[] {
  const entries = readProjectRegistry(options);
  return entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export interface WorktreeDetection {
  isWorktree: boolean;
  parentCwd?: string;
  branch?: string;
}

export function detectWorktree(cwd: string): WorktreeDetection {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
    const commonDir = execSync("git rev-parse --git-common-dir", { cwd, encoding: "utf-8" }).trim();
    const resolvedCommon = resolve(cwd, commonDir);
    const mainRepoGitDir = resolve(toplevel, ".git");

    if (resolvedCommon !== mainRepoGitDir) {
      const parentCwd = dirname(resolvedCommon);
      let branch: string | undefined;
      try {
        branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
        if (branch === "HEAD") branch = undefined;
      } catch {}
      return { isWorktree: true, parentCwd, branch };
    }
  } catch {}
  return { isWorktree: false };
}

export function addProject(
  cwd: string,
  name: string | undefined,
  options: ProjectRegistryOptions = {},
): DaemonProjectEntry {
  const resolved = cwd.startsWith("~/")
    ? join(homedir(), cwd.slice(2))
    : cwd === "~"
      ? homedir()
      : cwd;
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  const wt = detectWorktree(resolved);
  const projectName = name ?? resolved.split("/").filter(Boolean).pop() ?? "unknown";

  if (wt.isWorktree && wt.parentCwd) {
    const parentName = wt.parentCwd.split("/").filter(Boolean).pop() ?? "unknown";
    const parentEntries = readProjectRegistry(options);
    if (!parentEntries.some((e) => e.cwd === wt.parentCwd)) {
      const now = new Date().toISOString();
      parentEntries.push({ name: parentName, cwd: wt.parentCwd, lastSeen: now });
      writeProjectRegistry(parentEntries, options);
    }

    const entries = readProjectRegistry(options);
    const now = new Date().toISOString();
    const existing = entries.find((e) => e.cwd === resolved);
    if (existing) {
      existing.name = projectName;
      existing.lastSeen = now;
      existing.parentCwd = wt.parentCwd;
      existing.branch = wt.branch;
      writeProjectRegistry(entries, options);
      return existing;
    }
    const entry: DaemonProjectEntry = {
      name: projectName,
      cwd: resolved,
      lastSeen: now,
      parentCwd: wt.parentCwd,
      branch: wt.branch,
    };
    entries.push(entry);
    writeProjectRegistry(entries, options);
    return entry;
  }

  return registerProject(projectName, resolved, options);
}
