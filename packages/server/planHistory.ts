/**
 * Plan History Management
 *
 * Provides versioned storage for plans with auto-save on review.
 * Pattern: {slug}-v1.md, {slug}-v2.md, etc.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { createHash } from "crypto";

export interface PlanVersion {
  version: number;
  timestamp: string;
  hash: string;
  path: string;
  slug: string;
}

/**
 * Get the plan storage directory.
 */
function getPlanDir(customPath?: string | null): string {
  let planDir: string;

  if (customPath) {
    planDir = customPath.startsWith("~")
      ? join(homedir(), customPath.slice(1))
      : customPath;
  } else {
    planDir = join(homedir(), ".plannotator", "plans");
  }

  mkdirSync(planDir, { recursive: true });
  return planDir;
}

/**
 * Compute SHA256 hash of content for deduplication.
 */
function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Extract base slug from a versioned filename.
 * E.g., "2026-01-30-my-plan-v3.md" → "2026-01-30-my-plan"
 */
function extractBaseSlug(filename: string): string {
  // Remove .md extension
  const withoutExt = filename.replace(/\.md$/, "");
  // Remove version suffix if present
  return withoutExt.replace(/-v\d+$/, "");
}

/**
 * Parse version number from filename.
 * E.g., "2026-01-30-my-plan-v3.md" → 3
 * Returns 0 if no version suffix (legacy files).
 */
function parseVersionNumber(filename: string): number {
  const match = filename.match(/-v(\d+)\.md$/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * List all versions of a plan by its slug.
 * Returns versions sorted by version number (ascending).
 */
export function listVersions(slug: string, customPath?: string | null): PlanVersion[] {
  const planDir = getPlanDir(customPath);
  const baseSlug = extractBaseSlug(slug);

  if (!existsSync(planDir)) {
    return [];
  }

  const files = readdirSync(planDir);
  const versions: PlanVersion[] = [];

  for (const file of files) {
    // Skip non-markdown files
    if (!file.endsWith(".md")) continue;

    // Skip diff and snapshot files
    if (file.includes(".diff.") || file.includes("-approved.") || file.includes("-denied.")) {
      continue;
    }

    const fileBaseSlug = extractBaseSlug(file);
    if (fileBaseSlug !== baseSlug) continue;

    const filePath = join(planDir, file);
    const content = readFileSync(filePath, "utf-8");
    const version = parseVersionNumber(file);

    // For legacy files without version suffix, treat as v1
    const actualVersion = version === 0 ? 1 : version;

    versions.push({
      version: actualVersion,
      timestamp: getFileTimestamp(filePath),
      hash: computeHash(content),
      path: filePath,
      slug: baseSlug,
    });
  }

  // Sort by version number
  return versions.sort((a, b) => a.version - b.version);
}

/**
 * Get file modification time as ISO string.
 */
function getFileTimestamp(filePath: string): string {
  try {
    const { statSync } = require("fs");
    const stats = statSync(filePath);
    return stats.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Save a new version of a plan.
 * Returns the version number assigned.
 * Skips save if content hash matches latest version (no changes).
 */
export function saveVersion(
  slug: string,
  content: string,
  customPath?: string | null
): { version: number; path: string; skipped: boolean } {
  const planDir = getPlanDir(customPath);
  const baseSlug = extractBaseSlug(slug);
  const contentHash = computeHash(content);

  // Get existing versions
  const existingVersions = listVersions(baseSlug, customPath);

  // Check if content matches latest version (skip if no changes)
  if (existingVersions.length > 0) {
    const latestVersion = existingVersions[existingVersions.length - 1];
    if (latestVersion.hash === contentHash) {
      return {
        version: latestVersion.version,
        path: latestVersion.path,
        skipped: true,
      };
    }
  }

  // Calculate next version number
  const nextVersion = existingVersions.length > 0
    ? Math.max(...existingVersions.map(v => v.version)) + 1
    : 1;

  // Save with version suffix
  const filename = `${baseSlug}-v${nextVersion}.md`;
  const filePath = join(planDir, filename);
  writeFileSync(filePath, content, "utf-8");

  return {
    version: nextVersion,
    path: filePath,
    skipped: false,
  };
}

/**
 * Load a specific version of a plan.
 * Returns null if version doesn't exist.
 */
export function loadVersion(
  slug: string,
  version: number,
  customPath?: string | null
): string | null {
  const versions = listVersions(slug, customPath);
  const targetVersion = versions.find(v => v.version === version);

  if (!targetVersion) {
    return null;
  }

  return readFileSync(targetVersion.path, "utf-8");
}

/**
 * Get the latest version of a plan.
 */
export function getLatestVersion(
  slug: string,
  customPath?: string | null
): PlanVersion | null {
  const versions = listVersions(slug, customPath);
  if (versions.length === 0) return null;
  return versions[versions.length - 1];
}

/**
 * Compare two versions and return if they differ.
 */
export function versionsMatch(
  slug: string,
  v1: number,
  v2: number,
  customPath?: string | null
): boolean {
  const versions = listVersions(slug, customPath);
  const version1 = versions.find(v => v.version === v1);
  const version2 = versions.find(v => v.version === v2);

  if (!version1 || !version2) return false;
  return version1.hash === version2.hash;
}
