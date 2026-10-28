/**
 * Plannotator Inbox, Files: the guard for reading a thread's project folder
 * (owned by the Inbox; packages/server/inbox-files.ts is its only user).
 *
 * The rules (owner, "like VS Code", 2026-10-27; the routes answer on this
 * computer only, never over the tailnet):
 *  - A request names a plain relative path: no `..`, nothing absolute, no NUL
 *    (`normalizeProjectDir`). It is joined to the folder's real path, so it
 *    can only leave the folder through a symlink, and symlinks are followed
 *    wherever they lead, as VS Code follows them.
 *  - `.git` is never listed or read: not by the path asked for, and not by
 *    where it resolves to (a symlink into a repository's `.git`).
 *  - Dotenv files are never read (the attachment rule, `isDotenvFileName`, by
 *    the name asked for and by the file it resolves to; the caller checks).
 *  - A read opens the resolved file without following a last symlink and
 *    without blocking (a FIFO or a device is refused, never waited on),
 *    checks the open descriptor is a regular file, and reads at most the cap.
 */
import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { hasGitSegment, normalizeProjectDir } from "@plannotator/shared/project-listing";

export type FilesGuardReason = "invalid-path" | "not-found" | "not-a-file" | "not-a-dir" | "git";

export interface FilesGuardFailure {
  ok: false;
  reason: FilesGuardReason;
}

export interface ResolvedFilesPath {
  ok: true;
  /** The relative path as asked for, normalized (`""` is the folder itself). */
  rel: string;
  /** The folder's real path. */
  realRoot: string;
  /** Where the path resolves to, every symlink followed. */
  real: string;
}

const fail = (reason: FilesGuardReason): FilesGuardFailure => ({ ok: false, reason });

/** `.git` as a segment of an absolute real path. */
function realHasGitSegment(real: string): boolean {
  return real.split(/[\\/]/).some((segment) => segment === ".git");
}

/** A request's path, resolved under the folder: refused when it is not a plain relative path, is gone, or reaches `.git`. */
export function resolveFilesPath(root: string, raw: string | null): ResolvedFilesPath | FilesGuardFailure {
  const rel = normalizeProjectDir(raw);
  if (rel === null) return fail("invalid-path");
  if (hasGitSegment(rel)) return fail("git");
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return fail("not-found");
  }
  let real: string;
  try {
    real = rel === "" ? realRoot : realpathSync(join(realRoot, rel));
  } catch {
    return fail("not-found");
  }
  if (realHasGitSegment(real) && !realHasGitSegment(realRoot)) return fail("git");
  return { ok: true, rel, realRoot, real };
}

export type FilesRead =
  | { ok: true; bytes: Uint8Array; size: number; mtimeMs: number }
  /** Over the cap: nothing read. */
  | { ok: true; bytes: null; size: number; mtimeMs: number }
  | FilesGuardFailure;

/**
 * A resolved file's bytes, at most `maxBytes`: opened without following a
 * last symlink (the real path has none; one swapped in since is refused) and
 * without blocking, then proved a regular file by the open descriptor.
 */
export async function readFilesFile(real: string, maxBytes: number): Promise<FilesRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === "ELOOP" || code === "EISDIR" ? "not-a-file" : "not-found");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return fail("not-a-file");
    if (stat.size > maxBytes) return { ok: true, bytes: null, size: stat.size, mtimeMs: stat.mtimeMs };
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const { bytesRead } = await handle.read(buffer, read, stat.size - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { ok: true, bytes: buffer.subarray(0, read), size: read, mtimeMs: stat.mtimeMs };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
