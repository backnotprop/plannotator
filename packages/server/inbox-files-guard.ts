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
 *    After the open, the path is resolved again and must still be the same
 *    file (device and inode) at the same real path: a folder above it swapped
 *    for a link between the resolve and the open is refused.
 *  - Names only, as VS Code: a hard link to a dotenv file under another name
 *    is read (nothing on disk says which name is "the" file).
 */
import { constants, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
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

/**
 * A real path reaches a repository's `.git`: by its segments below the
 * folder when it is inside the folder (so a folder that itself sits under a
 * `.git`, a worktree made there, still lists), by every segment when a link
 * led it outside.
 */
export function reachesGit(realRoot: string, real: string): boolean {
  if (real === realRoot) return false;
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return realHasGitSegment(real.startsWith(prefix) ? real.slice(prefix.length) : real);
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
  if (reachesGit(realRoot, real)) return fail("git");
  return { ok: true, rel, realRoot, real };
}

export type FilesRead =
  | { ok: true; bytes: Uint8Array; size: number; mtimeMs: number }
  /** Over the cap: nothing read. */
  | { ok: true; bytes: null; size: number; mtimeMs: number }
  | FilesGuardFailure;

export type FilesOpen = { ok: true; handle: FileHandle; stat: Stats } | FilesGuardFailure;

/**
 * A resolved file, opened: without following a last symlink (the real path
 * has none; one swapped in since is refused) and without blocking, proved a
 * regular file by the open descriptor, and proved still to be the file at
 * that real path (resolved again after the open: same path, same device and
 * inode). The caller closes the handle.
 */
export async function openFilesFile(real: string): Promise<FilesOpen> {
  let handle: FileHandle;
  try {
    handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return fail(code === "ELOOP" || code === "EISDIR" ? "not-a-file" : "not-found");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close().catch(() => undefined);
      return fail("not-a-file");
    }
    let again: Stats;
    try {
      if (realpathSync(real) !== real) throw new Error("moved");
      again = statSync(real);
    } catch {
      await handle.close().catch(() => undefined);
      return fail("not-found");
    }
    if (again.dev !== stat.dev || again.ino !== stat.ino) {
      await handle.close().catch(() => undefined);
      return fail("not-found");
    }
    return { ok: true, handle, stat };
  } catch {
    await handle.close().catch(() => undefined);
    return fail("not-found");
  }
}

/** A resolved file's bytes, at most `maxBytes`, through `openFilesFile`. */
export async function readFilesFile(real: string, maxBytes: number): Promise<FilesRead> {
  const opened = await openFilesFile(real);
  if (!opened.ok) return opened;
  const { handle, stat } = opened;
  try {
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
