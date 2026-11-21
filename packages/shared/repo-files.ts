/**
 * The review tree's "All files": the whole repository at the revision the
 * diff's new side reads, and any one file of it (approved design record
 * "review-explorer", step 1).
 *
 * Runtime-neutral, vendored to Pi: both review servers route
 * `GET /api/repo-files` and `GET /api/repo-file` through the handlers here and
 * only say where the current mode lists and reads (a VCS provider, the PR's
 * local checkout, or the platform's tree API). Neither handler writes anything.
 *
 * Big repositories: the whole path list goes to the browser once per snapshot
 * (and again after a live change). Past `REPO_FILES_LAZY_THRESHOLD` paths the
 * list stays on the server and the browser asks for one folder at a time.
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
/** Go to File's search, for a listing too large to send whole (and for any client that wants it). */
export const REPO_FILES_SEARCH_ENDPOINT = "/api/repo-files/search";
/** Most matches one search answers. */
export const MAX_REPO_FILES_SEARCH_RESULTS = 100;

/** Above this many paths the list stays on the server and folders load one at a time. */
export const REPO_FILES_LAZY_THRESHOLD = 200_000;

/** The largest file `/api/repo-file` reads (the hunk-expansion cap). */
export const MAX_REPO_FILE_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;

/** Why a session offers no All files. */
export type RepoFilesUnavailableReason =
  | "static-patch"
  | "unsupported"
  | "no-checkout"
  | "failed";

export interface RepoFilesUnavailable {
  reason: RepoFilesUnavailableReason;
  message: string;
}

/** A file changed on disk after the diff was taken: added, edited or deleted. */
export type RepoOnDiskChange = "A" | "M" | "D";

/** One entry of a folder when the list is served a folder at a time. */
export interface RepoDirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  /** Files under a folder, at any depth. */
  files?: number;
}

export type RepoFilesResponse =
  | { available: false; reason: RepoFilesUnavailableReason; message: string }
  | {
      available: true;
      revision: RepoRevisionInfo;
      /** Files in the whole listing. */
      total: number;
      /** The working tree: the tree follows the disk over the stream endpoint. */
      live: boolean;
      truncated?: boolean;
      /** The whole sorted list (small repositories). */
      paths?: string[];
      /** One folder of the list (`dir`, "" for the root) when the list is too big to send. */
      lazy?: true;
      dir?: string;
      entries?: RepoDirEntry[];
      /** Files changed on disk since the diff was taken (live listings only). */
      onDisk?: Record<string, RepoOnDiskChange>;
    };

/** Why `/api/repo-file` has no text for a path it lists. */
export type RepoFileNoContentReason = "too-large" | "binary" | "missing" | "unavailable";

export interface RepoFileResponse {
  path: string;
  revision: RepoRevisionInfo;
  content: string | null;
  reason?: RepoFileNoContentReason;
  /** Bytes, when known (too-large). */
  size?: number;
}

/** What a server's reader returns: bytes from a VCS, or text from a platform API. */
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

// --- Listing cache --------------------------------------------------------

/**
 * One listing per snapshot, loaded once even when several requests race.
 * `invalidate` (a live change on disk) makes the next request list again.
 */
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

// --- Pure helpers ---------------------------------------------------------

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

/** Whether a sorted listing holds a path. */
export function repoListingHas(sorted: readonly string[], path: string): boolean {
  const index = lowerBound(sorted, path);
  return index < sorted.length && sorted[index] === path;
}

/**
 * The direct children of one folder of a sorted listing, folders with how many
 * files they hold. `dir` is "" for the root.
 */
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

// --- Changes on disk since the snapshot -----------------------------------

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

/** The diff's files, keyed by their new path, with whether the diff deletes them. */
export function diffFileStates(patch: string): Map<string, { deleted: boolean }> {
  const states = new Map<string, { deleted: boolean }>();
  for (const file of parseDiffToFiles(patch)) states.set(file.path, { deleted: file.status === "deleted" });
  return states;
}

/** Candidates checked for on-disk changes per refresh (a bound, not an expectation). */
const ON_DISK_CANDIDATE_LIMIT = 5000;

/**
 * Files changed on disk after the diff was taken, for a working-tree listing:
 * the diff's own files and anything `git status` now reports, compared by
 * modification time with when the diff was captured. A diff file that is gone
 * reads as deleted; a file outside the diff reads as added (untracked or
 * newly added) or edited.
 */
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

// --- Handlers ---------------------------------------------------------------

export interface RepoFilesRequestInput {
  params: URLSearchParams;
  /** Set when this session offers no All files (the response says why). */
  unavailable: RepoFilesUnavailable | null;
  isCurrentSnapshot: (snapshot: string) => boolean;
  loadListing: () => Promise<RepoFileListing | null>;
  /** On-disk changes for a live listing; omitted where nothing is live. */
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

/** `GET /api/repo-files?snapshot=<id>[&dir=<folder>]`. */
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
  /** Read one listed path at the listing's revision (VCS objects, platform APIs). */
  read: (path: string, maxBytes: number) => Promise<RepoFileRead>;
  /**
   * Read one working-tree file from disk. Required so neither runtime can
   * skip it: both pass `readRepoWorkingTreeFile` (repo-files-node.ts), which
   * goes through the shared reader in repo-file.ts (links followed like
   * VS Code, regular files only, the 5 MB cap, no FIFO hang).
   */
  readWorkingTree: (root: string, path: string, maxBytes: number) => RepoFileRead | Promise<RepoFileRead>;
}

/**
 * `GET /api/repo-file?path=<path>&snapshot=<id>`: one file of the listing, as
 * text. Only a listed path is read, so nothing `.gitignore` hides (an `.env`)
 * and no `..` path is reachable.
 */
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
  /** The diff's changed paths, which win ties. */
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

/**
 * `GET /api/repo-files/search?snapshot=<id>&q=<query>[&limit=<n>]`: Go to
 * File over the listed paths, best first (the fuzzy matcher the browser runs
 * on a listing it holds). Answers only listed paths, so it reveals nothing
 * `/api/repo-files` would not.
 */
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

// --- Live watching ----------------------------------------------------------

/**
 * How a live listing follows the disk. `watch`: the file watcher, with git's
 * ignored folders never watched. `poll`: a timer, for listings too large to
 * watch cheaply (past `REPO_FILES_LAZY_THRESHOLD`) and for multi-repo
 * workspaces, whose root is a parent folder of many repositories.
 */
export type RepoLiveMode = "watch" | "poll";
export const REPO_LIVE_POLL_MS = 5_000;
/** A polled listing that keeps finding nothing new backs off to this. */
export const REPO_LIVE_POLL_MAX_MS = 30_000;

/** The next poll delay: back to the start after a change, else 1.5 times longer up to the cap. */
export function nextRepoPollDelay(current: number, changed: boolean, start: number = REPO_LIVE_POLL_MS): number {
  if (changed) return start;
  return Math.min(Math.max(start, REPO_LIVE_POLL_MAX_MS), Math.round(current * 1.5));
}

export function repoLiveMode(listing: RepoFileListing, options: { workspace?: boolean; lazyThreshold?: number } = {}): RepoLiveMode {
  if (options.workspace) return "poll";
  return listing.paths.length > (options.lazyThreshold ?? REPO_FILES_LAZY_THRESHOLD) ? "poll" : "watch";
}

/**
 * What the tree shows of a working tree, as one string: git's status (tracked
 * changes, untracked files, deletions; never ignored files) and the
 * modification time of each path it reports. A write to a gitignored build
 * folder leaves it unchanged, so the tree is not listed again for it.
 */
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

/**
 * The folders (with a trailing `/`) and files git ignores in a working tree,
 * for the watcher's ignore rule, so build output (`target/`, `dist/`,
 * `node_modules/`) is never watched.
 */
export async function gitIgnoredEntries(runtime: ReviewGitRuntime, root: string): Promise<string[]> {
  const result = await runtime.runGit(
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { cwd: root, timeoutMs: 60_000 },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\0").filter(Boolean);
}

/** Whether a repository-relative path is one of `ignored` or inside an ignored folder. */
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
  /** Re-reads the signature; answers the version after it. */
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
  // The baseline: what the disk holds when watching starts.
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

/** Whether a watcher event under `root` can matter to the listing. */
export function isRepoWatchIgnored(relativePath: string): boolean {
  return relativePath
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => REPO_WATCH_IGNORED_NAMES.has(segment));
}
