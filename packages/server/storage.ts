/**
 * Plan Storage Utility
 *
 * Saves plans and annotations to ~/.plannotator/plans/
 * Cross-platform: works on Windows, macOS, and Linux.
 */

import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { sanitizeTag } from "./project";

/**
 * Get the plan storage directory, creating it if needed.
 * Cross-platform: uses os.homedir() for Windows/macOS/Linux compatibility.
 * @param customPath Optional custom path. Supports ~ for home directory.
 */
export function getPlanDir(customPath?: string | null): string {
  let planDir: string;

  if (customPath) {
    // Expand ~ to home directory
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
 * Extract the first heading from markdown content.
 */
function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

/**
 * Generate a slug from plan content.
 * Format: YYYY-MM-DD-{sanitized-heading}
 */
export function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;

  return slug ? `${date}-${slug}` : `${date}-plan`;
}

/**
 * Save the plan markdown to disk.
 * Returns the full path to the saved file.
 */
export function savePlan(slug: string, content: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.md`);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

/**
 * Save annotations (diff) to disk.
 * Returns the full path to the saved file.
 */
export function saveAnnotations(slug: string, diffContent: string, customPath?: string | null): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}.diff.md`);
  writeFileSync(filePath, diffContent, "utf-8");
  return filePath;
}

/**
 * Save the final snapshot on approve/deny.
 * Combines plan and diff into a single file with status suffix.
 * Returns the full path to the saved file.
 */
export function saveFinalSnapshot(
  slug: string,
  status: "approved" | "denied",
  plan: string,
  diff: string,
  customPath?: string | null
): string {
  const planDir = getPlanDir(customPath);
  const filePath = join(planDir, `${slug}-${status}.md`);

  // Combine plan with diff appended
  let content = plan;
  if (diff && diff !== "No changes detected.") {
    content += "\n\n---\n\n" + diff;
  }

  writeFileSync(filePath, content, "utf-8");
  return filePath;
}
