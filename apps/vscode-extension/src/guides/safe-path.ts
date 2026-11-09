/**
 * A repository file the Guide tab may open or read: inside the head's root
 * once every symlink is followed. A change can add a symlink
 * (`notes.md -> ~/.aws/credentials`); it is never followed out of the
 * repository. No `vscode`.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The real path of `path` (repo-relative) under `root`, or null when it is
 * not there, leaves the root (`..`, an absolute path, a symlink anywhere on
 * the way that points outside), or is not a regular file.
 */
export function realFileInside(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(root, path));
    if (!inside(realRoot, real)) return null;
    return lstatSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * True when a guide file's head side is a file on disk that is not a regular
 * file inside the repository once symlinks are followed (`notes.md ->
 * ~/.aws/credentials`, a folder, gone): it is not opened, hovered or read.
 * A deleted file's head is empty and a head revision is git's, so neither
 * leaves.
 */
export function headLeavesRepo(sides: { head: { kind: "fs"; root: string } | { kind: "rev"; rev: string } }, file: { path: string; status?: string }): boolean {
  return sides.head.kind === "fs" && file.status !== "deleted" && !realFileInside(sides.head.root, file.path);
}

/**
 * The bytes of a repository file when it is a regular file of its own (not a
 * symlink, even one pointing inside), for hashing what was asked about.
 */
export function readOwnFile(root: string, path: string): Buffer | null {
  const real = realFileInside(root, path);
  if (!real) return null;
  try {
    if (lstatSync(join(root, path)).isSymbolicLink()) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}

/**
 * Why a head file was not opened, in words: gone from the disk, or not a file
 * inside the repository (a symlink out of it, a folder). A path that names a
 * place outside the root is never looked up, so the answer says nothing about
 * what is there.
 */
export function headRefusal(root: string, path: string): string {
  const leaves = !path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0");
  if (!leaves) {
    try {
      lstatSync(join(root, path));
    } catch {
      return `${path} is not on disk.`;
    }
  }
  return `${path} is not a file inside the repository (a link out of it is not opened).`;
}
