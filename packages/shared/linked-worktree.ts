/**
 * Whether a folder is a linked git worktree, from its `.git` alone (no git
 * call): the open-in route uses it so an agent in a linked worktree never
 * falls back to the main checkout's copy of a file.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** A linked worktree's `.git` is a file saying `gitdir: <path>`, and that path exists; a main checkout's is a folder. */
export function isLinkedWorktree(folder: string): boolean {
  try {
    const dotGit = join(folder, ".git");
    if (!statSync(dotGit).isFile()) return false;
    const gitdir = /^gitdir: (.+)$/.exec(readFileSync(dotGit, "utf8").trim())?.[1];
    return !!gitdir && existsSync(resolve(folder, gitdir));
  } catch {
    return false;
  }
}
