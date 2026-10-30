/**
 * The Plannotator Inbox's Files view: the rules for listing a thread's
 * project folder and for refusing a file in it, with no filesystem and no
 * git (the server, packages/server/inbox-files.ts, does both and asks these
 * rules what they mean).
 *
 * Listing ("like VS Code", owner): everything in a folder except `.git`,
 * never listed at any depth. Gitignored entries are listed and marked
 * `ignored`. Hidden files and folders are listed and open like any other,
 * and symlinks are followed wherever they lead (owner, 2026-10-27; the
 * routes answer on this computer only). Two locks, names always shown:
 * a dotenv file's contents are never served (`locked: "dotenv"`, the
 * attachment rule `isDotenvFileName`, so `.env.example` stays readable), and
 * an entry that resolves into a repository's `.git` is never read
 * (`locked: "git"`).
 *
 * Every refusal is a short machine code ({@link ProjectFileRefusalCode});
 * the window owns the words.
 */

import { isDotenvFileName } from "@plannotator/core/annotatable";

/** At most this many entries of one folder are listed; `more` counts the rest. */
export const PROJECT_LISTING_MAX_ENTRIES = 5_000;

/** At most this many changed paths are reported; `truncated` says there were more. */
export const PROJECT_CHANGES_MAX = 20_000;

export type ProjectEntryKind = "dir" | "file";

/** Why a listed entry's contents are never served. */
export type ProjectEntryLock = "dotenv" | "git";

export interface ProjectEntry {
  name: string;
  kind: ProjectEntryKind;
  ignored: boolean;
  locked: ProjectEntryLock | null;
  size: number | null;
}

/** A change mark: modified, added, deleted, renamed (never produced today: renames are split), untracked. */
export type ProjectChangeMark = "M" | "A" | "D" | "R" | "U";

export type ProjectFileRefusalCode =
  | "invalid_path"
  | "not_found"
  | "not_a_dir"
  | "not_a_file"
  | "locked"
  | "too_large";

/** The HTTP status of each refusal. */
export const PROJECT_FILE_REFUSAL_STATUS: Record<ProjectFileRefusalCode, number> = {
  invalid_path: 400,
  not_found: 404,
  not_a_dir: 400,
  not_a_file: 400,
  locked: 403,
  too_large: 413,
};

/** The refusal for a failure of the Files guard (packages/server/inbox-files-guard.ts): `.git` is not found. */
export function projectFileRefusalOf(reason: "invalid-path" | "not-found" | "not-a-file" | "not-a-dir" | "git" | "too-large"): ProjectFileRefusalCode {
  switch (reason) {
    case "invalid-path":
      return "invalid_path";
    case "not-found":
    case "git":
      return "not_found";
    case "not-a-file":
      return "not_a_file";
    case "not-a-dir":
      return "not_a_dir";
    case "too-large":
      return "too_large";
  }
}

/** VS Code's explorer order for names: case-insensitive, numbers by value. */
const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then names in VS Code's order (ties by code unit, so the order is total). */
export function compareProjectEntries(a: { name: string; kind: ProjectEntryKind }, b: { name: string; kind: ProjectEntryKind }): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return NAME_ORDER.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** `.git` at any depth: never listed, never read. */
export function hasGitSegment(rel: string): boolean {
  return rel.split("/").some((segment) => segment === ".git");
}

/** The last segment of a `/` path. */
export function lastSegment(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at === -1 ? rel : rel.slice(at + 1);
}

/**
 * Why a file's contents are never served, or null when they may be:
 * `dotenv` when the path it was asked by or the file it resolves to has a
 * dotenv name.
 */
export function projectFileLock(requested: string, real: string): "dotenv" | null {
  if (isDotenvFileName(lastSegment(requested)) || isDotenvFileName(lastSegment(real))) return "dotenv";
  return null;
}

/** Split NUL-separated git output (`-z`), dropping the empty tail. */
export function splitNul(output: string): string[] {
  const parts = output.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * `git diff --name-status -z --no-renames` output as change marks: added
 * `A`, deleted `D`, anything else (modified, type changed, unmerged) `M`.
 * Returns the marks and whether the cap cut the list.
 */
export function parseNameStatusZ(output: string, max = PROJECT_CHANGES_MAX): { changes: Map<string, ProjectChangeMark>; truncated: boolean } {
  const parts = splitNul(output);
  const changes = new Map<string, ProjectChangeMark>();
  let truncated = false;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!;
    const path = parts[i + 1]!;
    if (changes.size >= max) {
      truncated = true;
      break;
    }
    const letter = status.charAt(0);
    changes.set(path, letter === "A" ? "A" : letter === "D" ? "D" : "M");
  }
  return { changes, truncated };
}

/**
 * The folder a request names: "" (absent or empty) for the root, otherwise
 * a relative `/` path with no `..`, no NUL and nothing absolute; null when
 * refused (`invalid_path`).
 */
export function normalizeProjectDir(raw: string | null): string | null {
  if (raw === null || raw === "") return "";
  if (raw.includes("\0")) return null;
  const slashed = raw.replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[a-zA-Z]:/.test(slashed)) return null;
  if (slashed.split("/").some((segment) => segment === "..")) return null;
  // Split on "/" only: on POSIX a backslash is a legal filename character.
  return raw.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}
