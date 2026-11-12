import { relative } from "node:path";

export function toRelativePath(absolutePath: string, cwd?: string): string {
  if (!cwd) return absolutePath;
  const rel = relative(cwd, absolutePath);
  if (rel.startsWith("..")) return absolutePath;
  return rel.replace(/\\/g, "/");
}
