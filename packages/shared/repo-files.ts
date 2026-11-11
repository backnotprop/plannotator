/**
 * The review tree's All files: the repository at the revision of the diff's new side, and any one file of it. Runtime-neutral; both review servers route through the handlers here.
 * Past `REPO_FILES_LAZY_THRESHOLD` paths the list stays on the server and the browser asks for one folder at a time.
 */

import {
  MAX_REVIEW_FILE_CONTENT_BYTES,
  compareRepoPaths,
  validateFilePath,
  type FileBytesRead,
  type RepoFileListing,
  type RepoRevisionInfo,
  type ReviewGitRuntime,
} from "./review-core";
import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { fuzzySearchPaths, type FuzzyPathMatch } from "./fuzzy-path";

export type { RepoFileListing, RepoRevisionInfo } from "./review-core";

export const REPO_FILES_ENDPOINT = "/api/repo-files";
export const REPO_FILE_ENDPOINT = "/api/repo-file";
export const REPO_FILES_STREAM_ENDPOINT = "/api/repo-files/stream";
export const REPO_FILES_SEARCH_ENDPOINT = "/api/repo-files/search";
export const MAX_REPO_FILES_SEARCH_RESULTS = 100;

export const REPO_FILES_LAZY_THRESHOLD = 200_000;

export const MAX_REPO_FILE_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;

export type RepoFilesUnavailableReason =
  | "static-patch"
  | "unsupported"
  | "no-checkout"
  | "failed";

export interface RepoFilesUnavailable {
  reason: RepoFilesUnavailableReason;
  message: string;
}

export type RepoOnDiskChange = "A" | "M" | "D";

export interface RepoDirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  files?: number;
}

export type RepoFilesResponse =
  | { available: false; reason: RepoFilesUnavailableReason; message: string }
  | {
      available: true;
      revision: RepoRevisionInfo;
      total: number;
      live: boolean;
      truncated?: boolean;
      paths?: string[];
      lazy?: true;
      dir?: string;
      entries?: RepoDirEntry[];
      onDisk?: Record<string, RepoOnDiskChange>;
    };

export type RepoFileNoContentReason = "too-large" | "binary" | "missing" | "unavailable";

export interface RepoFileResponse {
  path: string;
  revision: RepoRevisionInfo;
  content: string | null;
  reason?: RepoFileNoContentReason;
  size?: number;
}

export type RepoFileRead =
  | FileBytesRead
  | { kind: "text"; content: string | null }
  | { kind: "binary" };

/**
 * Where one listed path is a file on disk, or null when it is read from a VCS
 * object or a platform API. A working-tree listing reads from its root; a
 * multi-repo workspace from the child repository whose folder holds the path.
 */
export function repoFileDiskLocation(listing: RepoFileListing, path: string): { root: string; path: string } | null {
  if (listing.diskRoots) {
    let best: { prefix: string; root: string } | null = null;
    for (const entry of listing.diskRoots) {
      if (path.startsWith(entry.prefix) && (!best || entry.prefix.length > best.prefix.length)) best = entry;
    }
    return best ? { root: best.root, path: path.slice(best.prefix.length) } : null;
  }
  return listing.live && listing.root ? { root: listing.root, path } : null;
}

export interface HandlerResult {
  status: number;
  body: unknown;
}

export interface RepoListingCache {
  get(key: string, load: () => Promise<RepoFileListing | null>): Promise<RepoFileListing | null>;
  invalidate(): void;
  /** Bumps on every invalidate; part of no key the caller passes. */
  readonly generation: number;
}

export function createRepoListingCache(): RepoListingCache {
  let entry: { key: string; generation: number; value: Promise<RepoFileListing | null> } | null = null;
  let generation = 0;
  return {
    get(key, load) {
      if (entry && entry.key === key && entry.generation === generation) return entry.value;
      const value = load().catch(() => null);
      const created = { key, generation, value };
      entry = created;
      // A failed listing is not kept: the next request tries again.
      void value.then((result) => {
        if (result === null && entry === created) entry = null;
      });
      return value;
    },
    invalidate() {
      generation += 1;
      entry = null;
    },
    get generation() {
      return generation;
    },
  };
}

function lowerBound(sorted: readonly string[], value: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareRepoPaths(sorted[mid], value) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function repoListingHas(sorted: readonly string[], path: string): boolean {
  const index = lowerBound(sorted, path);
  return index < sorted.length && sorted[index] === path;
}

export function repoDirEntries(sorted: readonly string[], dir: string): RepoDirEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const start = prefix ? lowerBound(sorted, prefix) : 0;
  const folders = new Map<string, number>();
  const files: RepoDirEntry[] = [];
  for (let i = start; i < sorted.length; i++) {
    const path = sorted[i];
    if (prefix && !path.startsWith(prefix)) break;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, path, type: "file" });
    } else {
      const name = rest.slice(0, slash);
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
  }
  const dirs: RepoDirEntry[] = [...folders].map(([name, count]) => ({
    name,
    path: prefix + name,
    type: "dir",
    files: count,
  }));
  return [...dirs, ...files];
}

/** A path from a request: repository-relative, no `..`, no control characters. */
export function isSafeRepoRequestPath(path: string): boolean {
  if (!path || path.length > 4096) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.split("/").some((segment) => segment === "")) return false;
  try {
    validateFilePath(path);
  } catch {
    return false;
  }
  return true;
}

/** Text of a file, or why it has none: NUL in the first 8 KB or invalid UTF-8 reads as binary. */
export function decodeRepoFileBytes(bytes: Uint8Array): { content: string } | { reason: "binary" } {
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  if (head.includes(0)) return { reason: "binary" };
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { reason: "binary" };
  }
}

/** Parse `git status --porcelain=v1 -z`: path -> two-letter code (renames keep the new path). */
export function parsePorcelainZ(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    entries.set(entry.slice(3), code);
    // A rename or copy is followed by its original path.
    if (code[0] === "R" || code[0] === "C") i += 1;
  }
  return entries;
}

export function diffFileStates(patch: string): Map<string, { deleted: boolean }> {
  const states = new Map<string, { deleted: boolean }>();
  for (const file of parseDiffToFiles(patch)) states.set(file.path, { deleted: file.status === "deleted" });
  return states;
}

/** Candidates checked for on-disk changes per refresh (a bound, not an expectation). */
const ON_DISK_CANDIDATE_LIMIT = 5000;

/** Files changed on disk after the diff was taken, for a working-tree listing: the diff's own files and anything `git status` reports, compared by mtime with when the diff was captured. */
export async function findRepoOnDiskChanges(
  runtime: ReviewGitRuntime,
  root: string,
  diffFiles: ReadonlyMap<string, { deleted: boolean }>,
  capturedAt: number,
): Promise<Record<string, RepoOnDiskChange>> {
  const status = await runtime.runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: root, timeoutMs: 60_000 },
  );
  const reported = status.exitCode === 0 ? parsePorcelainZ(status.stdout) : new Map<string, string>();
  const candidates = new Set<string>([...diffFiles.keys(), ...reported.keys()]);
  const changes: Record<string, RepoOnDiskChange> = {};
  let checked = 0;
  for (const path of candidates) {
    if (checked++ >= ON_DISK_CANDIDATE_LIMIT) break;
    const info = await runtime.getFileInfo(root, path).catch(() => null);
    const inDiff = diffFiles.get(path);
    if (!info) {
      if (inDiff && !inDiff.deleted) changes[path] = "D";
      continue;
    }
    if (!(info.mtimeMs > capturedAt)) continue;
    if (inDiff) {
      changes[path] = "M";
    } else {
      const code = reported.get(path) ?? "";
      changes[path] = code === "??" || code[0] === "A" ? "A" : "M";
    }
  }
  return changes;
}

export interface RepoFilesRequestInput {
  params: URLSearchParams;
  unavailable: RepoFilesUnavailable | null;
  isCurrentSnapshot: (snapshot: string) => boolean;
  loadListing: () => Promise<RepoFileListing | null>;
  loadOnDisk?: (listing: RepoFileListing) => Promise<Record<string, RepoOnDiskChange> | null>;
  lazyThreshold?: number;
}

const STALE_BODY = { error: "Diff snapshot is stale; refresh first", reason: "stale" };

const onDiskByListing = new WeakMap<RepoFileListing, Promise<Record<string, RepoOnDiskChange> | null>>();
function onDiskOnce(
  listing: RepoFileListing,
  load: (listing: RepoFileListing) => Promise<Record<string, RepoOnDiskChange> | null>,
): Promise<Record<string, RepoOnDiskChange> | null> {
  let pending = onDiskByListing.get(listing);
  if (!pending) {
    pending = load(listing).catch(() => null);
    onDiskByListing.set(listing, pending);
  }
  return pending;
}

export async function handleRepoFilesRequest(input: RepoFilesRequestInput): Promise<HandlerResult> {
  const snapshot = input.params.get("snapshot");
  if (!snapshot) return { status: 400, body: { error: "Missing snapshot", reason: "bad-request" } };
  if (input.unavailable) {
    return { status: 200, body: { available: false, ...input.unavailable } satisfies RepoFilesResponse };
  }
  if (!input.isCurrentSnapshot(snapshot)) return { status: 409, body: STALE_BODY };
  const dir = input.params.get("dir") ?? "";
  if (dir && !isSafeRepoRequestPath(dir)) return { status: 400, body: { error: "Invalid folder", reason: "bad-request" } };

  const listing = await input.loadListing();
  if (!listing) {
    return {
      status: 200,
      body: { available: false, reason: "failed", message: "The repository's files could not be listed." } satisfies RepoFilesResponse,
    };
  }
  // The snapshot can move while the listing loads.
  if (!input.isCurrentSnapshot(snapshot)) return { status: 409, body: STALE_BODY };

  const threshold = input.lazyThreshold ?? REPO_FILES_LAZY_THRESHOLD;
  // What changed on disk since the snapshot: once per listing (a live change
  // lists again, so a new listing object), and only with the root request.
  const onDisk = listing.live && input.loadOnDisk && dir === "" ? await onDiskOnce(listing, input.loadOnDisk) : null;
  const base = {
    available: true as const,
    revision: listing.revision,
    total: listing.paths.length,
    live: listing.live,
    ...(listing.truncated ? { truncated: true } : {}),
    ...(onDisk && Object.keys(onDisk).length > 0 ? { onDisk } : {}),
  };
  if (listing.paths.length > threshold) {
    return {
      status: 200,
      body: { ...base, lazy: true, dir, entries: repoDirEntries(listing.paths, dir) } satisfies RepoFilesResponse,
    };
  }
  return { status: 200, body: { ...base, paths: listing.paths } satisfies RepoFilesResponse };
}

export interface RepoFileRequestInput {
  params: URLSearchParams;
  unavailable: RepoFilesUnavailable | null;
  isCurrentSnapshot: (snapshot: string) => boolean;
  loadListing: () => Promise<RepoFileListing | null>;
  read: (path: string, maxBytes: number) => Promise<RepoFileRead>;
  /** Read one working-tree file from disk. Required so neither runtime can skip it: both pass `readRepoWorkingTreeFile`. */
  readWorkingTree: (root: string, path: string, maxBytes: number) => RepoFileRead | Promise<RepoFileRead>;
}

/** `GET /api/repo-file`: only a listed path is read, so nothing `.gitignore` hides (an `.env`) and no `..` path is reachable. */
export async function handleRepoFileRequest(input: RepoFileRequestInput): Promise<HandlerResult> {
  const snapshot = input.params.get("snapshot");
  const path = input.params.get("path") ?? "";
  if (!snapshot) return { status: 400, body: { error: "Missing snapshot", reason: "bad-request" } };
  if (!isSafeRepoRequestPath(path)) return { status: 400, body: { error: "Invalid path", reason: "bad-request" } };
  if (input.unavailable) return { status: 400, body: { error: input.unavailable.message, reason: input.unavailable.reason } };
  if (!input.isCurrentSnapshot(snapshot)) return { status: 409, body: STALE_BODY };
  const listing = await input.loadListing();
  if (!listing) return { status: 400, body: { error: "The repository's files could not be listed.", reason: "failed" } };
  if (!repoListingHas(listing.paths, path)) {
    return { status: 404, body: { error: "Not a file of this revision", reason: "not-listed" } };
  }

  const disk = repoFileDiskLocation(listing, path);
  const read = await Promise.resolve()
    .then(() => (disk ? input.readWorkingTree(disk.root, disk.path, MAX_REPO_FILE_BYTES) : input.read(path, MAX_REPO_FILE_BYTES)))
    .catch((): RepoFileRead => ({ kind: "missing" }));
  const answer = (rest: Pick<RepoFileResponse, "content" | "reason" | "size">): HandlerResult => ({
    status: 200,
    body: { path, revision: listing.revision, ...rest } satisfies RepoFileResponse,
  });
  switch (read.kind) {
    case "text":
      return read.content === null ? answer({ content: null, reason: "unavailable" }) : answer({ content: read.content });
    case "ok": {
      const decoded = decodeRepoFileBytes(read.bytes);
      return "content" in decoded ? answer({ content: decoded.content }) : answer({ content: null, reason: "binary" });
    }
    case "binary":
      return answer({ content: null, reason: "binary" });
    case "too-large":
      return answer({ content: null, reason: "too-large", size: read.size });
    case "missing":
      return answer({ content: null, reason: "missing" });
    default:
      return answer({ content: null, reason: "unavailable" });
  }
}

export interface RepoFilesSearchResponse {
  query: string;
  total: number;
  matches: FuzzyPathMatch[];
}

export interface RepoFilesSearchRequestInput {
  params: URLSearchParams;
  unavailable: RepoFilesUnavailable | null;
  isCurrentSnapshot: (snapshot: string) => boolean;
  loadListing: () => Promise<RepoFileListing | null>;
  preferred?: ReadonlySet<string>;
}

// One lowercased copy per listing, so a search per keystroke does not
// lowercase hundreds of thousands of paths each time.
const lowerPathsByListing = new WeakMap<readonly string[], string[]>();
function lowerPathsOf(paths: readonly string[]): string[] {
  let lower = lowerPathsByListing.get(paths);
  if (!lower) {
    lower = paths.map((path) => path.toLowerCase());
    lowerPathsByListing.set(paths, lower);
  }
  return lower;
}

/** Go to File over the listed paths. Answers only listed paths, so it reveals nothing `/api/repo-files` would not. */
export async function handleRepoFilesSearchRequest(input: RepoFilesSearchRequestInput): Promise<HandlerResult> {
  const snapshot = input.params.get("snapshot");
  if (!snapshot) return { status: 400, body: { error: "Missing snapshot", reason: "bad-request" } };
  const query = (input.params.get("q") ?? "").slice(0, 256);
  const limitParam = Number(input.params.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(MAX_REPO_FILES_SEARCH_RESULTS, Math.floor(limitParam))) : 50;
  if (input.unavailable) return { status: 400, body: { error: input.unavailable.message, reason: input.unavailable.reason } };
  if (!input.isCurrentSnapshot(snapshot)) return { status: 409, body: STALE_BODY };
  const listing = await input.loadListing();
  if (!listing) return { status: 400, body: { error: "The repository's files could not be listed.", reason: "failed" } };
  if (!input.isCurrentSnapshot(snapshot)) return { status: 409, body: STALE_BODY };
  const matches = fuzzySearchPaths(listing.paths, query, {
    limit,
    preferred: input.preferred,
    lowerPaths: lowerPathsOf(listing.paths),
  });
  return { status: 200, body: { query, total: listing.paths.length, matches } satisfies RepoFilesSearchResponse };
}

/**
 * How a live listing follows the disk. `watch`: the file watcher, with git's
 * ignored folders never watched. `poll`: a timer, for listings too large to
 * watch cheaply (past `REPO_FILES_LAZY_THRESHOLD`) and for multi-repo
 * workspaces, whose root is a parent folder of many repositories.
 */
export type RepoLiveMode = "watch" | "poll";
export const REPO_LIVE_POLL_MS = 5_000;
export const REPO_LIVE_POLL_MAX_MS = 30_000;

export function nextRepoPollDelay(current: number, changed: boolean, start: number = REPO_LIVE_POLL_MS): number {
  if (changed) return start;
  return Math.min(Math.max(start, REPO_LIVE_POLL_MAX_MS), Math.round(current * 1.5));
}

export function repoLiveMode(listing: RepoFileListing, options: { workspace?: boolean; lazyThreshold?: number } = {}): RepoLiveMode {
  if (options.workspace) return "poll";
  return listing.paths.length > (options.lazyThreshold ?? REPO_FILES_LAZY_THRESHOLD) ? "poll" : "watch";
}

/** What the tree shows of a working tree as one string: git's status plus the mtime of each reported path. A write to a gitignored build folder leaves it unchanged. */
export async function gitLiveSignature(runtime: ReviewGitRuntime, root: string): Promise<string | null> {
  const status = await runtime.runGit(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (status.exitCode !== 0) return null;
  const reported = parsePorcelainZ(status.stdout);
  const parts: string[] = [];
  let checked = 0;
  for (const [path, code] of reported) {
    if (checked++ >= ON_DISK_CANDIDATE_LIMIT) break;
    const info = await runtime.getFileInfo(root, path).catch(() => null);
    parts.push(`${code}\t${path}\t${info ? info.mtimeMs : "-"}`);
  }
  return parts.join("\n");
}

/** The folders and files git ignores, for the watcher's ignore rule, so build output is never watched. */
export async function gitIgnoredEntries(runtime: ReviewGitRuntime, root: string): Promise<string[]> {
  const result = await runtime.runGit(
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

export function isUnderIgnoredEntry(relativePath: string, ignored: ReadonlySet<string>): boolean {
  const path = relativePath.split("\\").join("/");
  if (ignored.has(path) || ignored.has(`${path}/`)) return true;
  let slash = path.indexOf("/");
  while (slash !== -1) {
    if (ignored.has(path.slice(0, slash + 1))) return true;
    slash = path.indexOf("/", slash + 1);
  }
  return false;
}

/**
 * Tells the watcher's events (or the poll's ticks) apart from real changes: a
 * change is a new signature. Shared by every page watching one root; each
 * page keeps the version it last saw. Checks are single-flight.
 */
export interface RepoChangeGate {
  check(): Promise<number>;
  readonly version: number;
}

export function createRepoChangeGate(signature: () => Promise<string | null>): RepoChangeGate {
  let last: string | null | undefined;
  let version = 0;
  let inFlight: Promise<number> | null = null;
  let again = false;
  const run = async (): Promise<number> => {
    do {
      again = false;
      const next = await signature().catch(() => null);
      if (next !== null) {
        if (last !== undefined && next !== last) version += 1;
        last = next;
      }
    } while (again);
    return version;
  };
  const gate: RepoChangeGate = {
    check() {
      if (inFlight) {
        again = true;
        return inFlight;
      }
      inFlight = run().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    get version() {
      return version;
    },
  };
  void gate.check();
  return gate;
}


/**
 * Folder names whose changes never reach the tree (dependency and cache
 * folders that are always ignored). Tracked output folders (`dist`, `build`,
 * `public`) are deliberately not here: their changes can be real files.
 */
export const REPO_WATCH_IGNORED_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".svelte-kit",
  ".nuxt",
  ".output",
]);

export function isRepoWatchIgnored(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => REPO_WATCH_IGNORED_NAMES.has(segment));
}
