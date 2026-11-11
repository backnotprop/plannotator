/** Strips a cwd prefix to a forward-slash repo-relative path for diff matching. */
import { relative } from "node:path";

export function toRelativePath(absolutePath: string, cwd?: string): string {
  if (!cwd) return absolutePath;
  const rel = relative(cwd, absolutePath);
  // Don't relativize if the result goes outside cwd (different drive, symlink escape)
  if (rel.startsWith("..")) return absolutePath;
  return rel.replace(/\\/g, "/");
}
