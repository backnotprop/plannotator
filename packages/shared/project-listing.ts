/**
 * The Plannotator Inbox's Files view: the rules for listing a thread's
 * project folder and for refusing a file in it, with no filesystem and no
 * git (the server, packages/server/inbox-files.ts, does both and asks these
 * rules what they mean).
 *
 * Listing ("like VS Code", owner): everything in a folder except `.git`,
 * never listed at any depth. Gitignored entries are listed and marked
 * `ignored`. Names are always browsable; contents are refused for a dotenv
 * file (`locked: "dotenv"`, the attachment rule `isDotenvFileName`, so
 * `.env.example` stays readable), for a file under a hidden segment git
 * tracks nothing at or under (`locked: "hidden"`: `.claude/`, `.npmrc`, any
 * hidden entry of a folder that is not a git repository, which protects a
 * project at a home folder such as `~/.ssh`), and for a symlink that leaves
 * the root or leads nowhere (`locked: "outside"`, listed as a file, never
 * expandable). A hidden folder git tracks nothing under is listed unlocked
 * and expandable; its files are locked.
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
export type ProjectEntryLock = "dotenv" | "hidden" | "outside";

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
  | "outside_root"
  | "not_found"
  | "not_a_dir"
  | "not_a_file"
  | "locked"
  | "too_large"
  | "changed";

/** The HTTP status of each refusal. */
export const PROJECT_FILE_REFUSAL_STATUS: Record<ProjectFileRefusalCode, number> = {
  invalid_path: 400,
  outside_root: 403,
  not_found: 404,
  not_a_dir: 400,
  not_a_file: 400,
  locked: 403,
  too_large: 413,
  changed: 409,
};

/** The refusal for a failure of the repo-file guard (packages/shared/repo-file.ts). */
export function projectFileRefusalOf(reason: "invalid-path" | "outside-root" | "not-found" | "not-a-file" | "too-large" | "changed"): ProjectFileRefusalCode {
  switch (reason) {
    case "invalid-path":
      return "invalid_path";
    case "outside-root":
      return "outside_root";
    case "not-found":
      return "not_found";
    case "not-a-file":
      return "not_a_file";
    case "too-large":
      return "too_large";
    case "changed":
      return "changed";
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

/**
 * Every prefix of `rel` that ends in a hidden segment (`a/.b/c/.d/e` →
 * `a/.b`, `a/.b/c/.d`): the paths git must track something at or under for
 * the files below them to be readable.
 */
export function hiddenSegmentPrefixes(rel: string): string[] {
  if (rel === "") return [];
  const segments = rel.split("/");
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.startsWith(".")) out.push(segments.slice(0, i + 1).join("/"));
  }
  return out;
}

/** The last segment of a `/` path. */
export function lastSegment(rel: string): string {
  const at = rel.lastIndexOf("/");
  return at === -1 ? rel : rel.slice(at + 1);
}

/**
 * Why a file's contents are never served, or null when they may be:
 * `dotenv` when the path it was asked by or the file it resolves to has a
 * dotenv name; `hidden` when either path has a hidden segment git tracks
 * nothing at or under (`tracked` answers for one such prefix).
 */
export function projectFileLock(requested: string, real: string, tracked: (prefix: string) => boolean): Exclude<ProjectEntryLock, "outside"> | null {
  if (isDotenvFileName(lastSegment(requested)) || isDotenvFileName(lastSegment(real))) return "dotenv";
  for (const prefix of [...hiddenSegmentPrefixes(requested), ...hiddenSegmentPrefixes(real)]) {
    if (!tracked(prefix)) return "hidden";
  }
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
