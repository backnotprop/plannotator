/**
 * Strip a cwd prefix from an absolute path to get a repo-relative path.
 * Used by review agent transforms to convert absolute file paths from
 * agent output into diff-compatible relative paths.
 *
 * Uses path.relative for cross-platform support (Windows backslashes)
 * and normalizes to forward slashes for git diff path matching.
 */
import { isAbsolute, relative, sep } from "node:path";

export function toRelativePath(absolutePath: string, cwd?: string): string {
  if (!cwd) return absolutePath;
  const rel = relative(cwd, absolutePath);
  // A different Windows drive stays absolute. Only a full parent component escapes cwd.
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return absolutePath;
  // Normalize to forward slashes for diff path matching
  return rel.split(sep).join("/");
}
