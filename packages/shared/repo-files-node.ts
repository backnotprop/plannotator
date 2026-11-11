/** The All files reader for working-tree files (`GET /api/repo-file`), server only. Kept out of repo-files.ts, which the review page also imports, because it needs node:fs. */

import { readRepoFile } from "./repo-file";
import { decodeRepoFileBytes, type RepoFileRead } from "./repo-files";

/** Read one working-tree file, decoded the way a file read from git is (a NUL or invalid UTF-8 is binary). */
export async function readRepoWorkingTreeFile(root: string, path: string, maxBytes: number): Promise<RepoFileRead> {
  let bytes: Uint8Array | null = null;
  const result = await readRepoFile(root, path, {
    maxBytes,
    decode: (read) => {
      bytes = read;
      return "";
    },
  });
  if (!result.ok) {
    switch (result.reason) {
      case "too-large":
        return { kind: "too-large", size: result.size ?? maxBytes + 1 };
      case "not-found":
        return { kind: "missing" };
      default:
        return { kind: "unavailable" };
    }
  }
  if (!bytes) return { kind: "unavailable" };
  const decoded = decodeRepoFileBytes(bytes);
  return "content" in decoded ? { kind: "text", content: decoded.content } : { kind: "binary" };
}
