/**
 * Plannotator Inbox: Files, the thread's project folder browsed and
 * commented on from the window (Bun only; mounted beside the attachment
 * routes in packages/server/inbox.ts, behind the Inbox's Host, Origin and
 * same-origin guards).
 *
 *   GET  /api/inbox/threads/:id/files/folder        which folder, or why none (no listing)
 *   GET  /api/inbox/threads/:id/files?dir=          one folder level
 *   GET  /api/inbox/threads/:id/files/content?path= a file for the viewers
 *   GET  /api/inbox/threads/:id/files/raw?path=     its bytes (img, video, Download)
 *   GET  /api/inbox/threads/:id/files/changed       change marks since the thread began
 *   POST /api/inbox/threads/:id/files/annotations   a comment on a file
 *
 * The files root is the folder the thread's latest agent message was sent
 * from, taken to its project root, or to its linked worktree when that is
 * where the agent works; never the home folder, a folder holding it, or `/`
 * ({@link inboxThreadFilesFolder}). Every read goes
 * through the repo-file guard (packages/shared/repo-file.ts: realpath
 * containment, a descriptor that is proved to be the contained file, a byte
 * cap); the listing and lock rules are packages/shared/project-listing.ts.
 * Names are browsable; contents of a dotenv file, of a file under a hidden
 * segment git tracks nothing under, and of anything outside the root are
 * never served. A request another site makes is refused before anything is
 * read. Every refusal is a short code; the window owns the words.
 */

import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_VIEW_MAX_BYTES, isInboxAnnotatableKind, isInboxTextBytes, isInboxTextKind, type InboxAttachmentKind, type InboxThread } from "@plannotator/core/inbox-types";
import { checkRepoRoot, isContainedPath, readRepoWorkingTreeBytes, resolveRepoFilePath, validateRepoFilePath, type RepoFileFailure } from "@plannotator/shared/repo-file";
import {
  compareProjectEntries,
  hasGitSegment,
  hiddenSegmentPrefixes,
  normalizeProjectDir,
  parseNameStatusZ,
  PROJECT_CHANGES_MAX,
  PROJECT_FILE_REFUSAL_STATUS,
  PROJECT_LISTING_MAX_ENTRIES,
  projectFileLock,
  projectFileRefusalOf,
  splitNul,
  type ProjectChangeMark,
  type ProjectEntry,
  type ProjectEntryKind,
  type ProjectEntryLock,
  type ProjectFileRefusalCode,
} from "@plannotator/shared/project-listing";
import { decideInboxAttachmentKind, INBOX_ATTACHMENT_HEAD_BYTES, isPdfHead } from "@plannotator/shared/inbox/attachments";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { readMp4VideoMetadata, sniffInboxVideo } from "@plannotator/shared/inbox/video";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { contentDisposition } from "./inbox-attachments";
import { inboxProjectRootGitEnv, type InboxProjectRoot } from "./inbox-project-root";

/** The raw route's cap: bigger files are refused (`too_large`). */
export const INBOX_FILES_RAW_MAX_BYTES = 64 * 1024 * 1024;
/** One git run for the Files view never takes longer than this. */
export const INBOX_FILES_GIT_TIMEOUT_MS = 5_000;
/** The changes route's git runs (a diff of a large tree) get longer. */
export const INBOX_FILES_CHANGES_GIT_TIMEOUT_MS = 15_000;
/** At most this much of one git answer is read. */
const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** A request another site (or another localhost port) made: refused before anything is read. */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

// --- git ---------------------------------------------------------------------

export interface InboxFilesGitResult {
  exitCode: number;
  stdout: string;
  /** The output was cut (the byte cap, or `onRecord` asked to stop). */
  stopped: boolean;
}

/**
 * One bounded git run in `cwd`: killed at the time limit (then null), its
 * output read up to a cap, optionally record by record (NUL-separated) so a
 * caller can stop early. Run without the variables that point git at
 * another repository, never prompting, never taking optional locks (so a
 * read never rewrites the index), with every pathspec literal (except for
 * `check-ignore`, which refuses the literal magic and reads its stdin as
 * plain paths).
 */
async function runGit(
  args: readonly string[],
  cwd: string,
  options: { input?: string; timeoutMs?: number; maxBytes?: number; onRecord?: (record: string) => boolean; literal?: boolean } = {},
): Promise<InboxFilesGitResult | null> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      env: { ...inboxProjectRootGitEnv(), ...(options.literal === false ? {} : { GIT_LITERAL_PATHSPECS: "1" }), GIT_OPTIONAL_LOCKS: "0" },
      stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
  } catch {
    return null;
  }
  let timedOut = false;
  let stoppedEarly = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, options.timeoutMs ?? INBOX_FILES_GIT_TIMEOUT_MS);
  const maxBytes = options.maxBytes ?? GIT_MAX_OUTPUT_BYTES;
  const decoder = new TextDecoder();
  let stdout = "";
  let pending = "";
  let bytes = 0;
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      if (options.onRecord) {
        pending += text;
        let at: number;
        while ((at = pending.indexOf("\0")) !== -1) {
          const record = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (options.onRecord(record)) {
            stoppedEarly = true;
            break;
          }
        }
      } else {
        stdout += text;
      }
      if (stoppedEarly || bytes > maxBytes) {
        stoppedEarly = true;
        proc.kill("SIGKILL");
        break;
      }
    }
    const exitCode = await proc.exited;
    if (timedOut) return null;
    if (stoppedEarly) return { exitCode: 0, stdout, stopped: true };
    if (exitCode > 128) return null;
    return { exitCode, stdout, stopped: false };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

interface GitState {
  git: boolean;
  branch: string | null;
}

async function gitState(root: string, withBranch: boolean): Promise<GitState> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], root);
  if (!inside || inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { git: false, branch: null };
  if (!withBranch) return { git: true, branch: null };
  const branch = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], root);
  const name = branch && branch.exitCode === 0 ? branch.stdout.trim() : "";
  return { git: true, branch: name || null };
}

/**
 * Which of `prefixes` git tracks something at or under (one `ls-files` run,
 * stopped once every prefix is seen). Not a git repository, or a git that
 * cannot answer: none, so every hidden file stays locked.
 */
async function trackedPrefixes(root: string, isGit: boolean, prefixes: Iterable<string>): Promise<Set<string>> {
  const wanted = new Set(prefixes);
  const seen = new Set<string>();
  if (!isGit || wanted.size === 0) return seen;
  await runGit(["ls-files", "-z", "--cached", "--", ...wanted], root, {
    maxBytes: 8 * 1024 * 1024,
    onRecord: (path) => {
      // Each ancestor of the path (and the path) that was asked about is tracked.
      let at = path.length;
      while (at > 0) {
        const prefix = path.slice(0, at);
        if (wanted.has(prefix)) seen.add(prefix);
        at = path.lastIndexOf("/", at - 1);
      }
      return seen.size === wanted.size;
    },
  });
  return seen;
}

/** Which of `paths` git ignores (`check-ignore`; tracked files are never ignored). */
async function ignoredPaths(root: string, isGit: boolean, paths: readonly string[]): Promise<Set<string>> {
  if (!isGit || paths.length === 0) return new Set();
  const answer = await runGit(["check-ignore", "--stdin", "-z"], root, { input: paths.map((p) => `${p}\0`).join(""), literal: false });
  // 1: none ignored; 128: git could not judge (a path in a submodule): none marked.
  if (!answer || answer.exitCode !== 0) return new Set();
  return new Set(splitNul(answer.stdout));
}

// --- the files root ------------------------------------------------------------

/** The thread's project folder, or why it has none. */
export type InboxFilesFolder =
  | {
      root: string;
      /** The thread's project name (`ledger`). */
      project: string;
      /** The linked worktree's folder name when the folder is one (`agent-a7d33112`), else null. */
      worktree: string | null;
      /** The folder's path for people: under the home folder as `~/…`. */
      path: string;
    }
  | { root: null; reason: "home" | "gone" };

/** A path for people: `~/…` under the home folder. */
function displayPath(real: string, home: string | null): string {
  if (home && real !== home && isContainedPath(real, home)) return `~/${relative(home, real).split(sep).join("/")}`;
  return real;
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * The folder the Files view shows for a thread: the folder its latest agent
 * message was sent from (`base_path`), taken to the project root, or to its
 * linked worktree when the project folded that worktree in (an agent in
 * `.claude/worktrees/agent-…`). A message sent from the project root (no
 * `base_path`), or a thread no agent wrote in: the project root. None
 * (`gone`) when that folder is gone or not a folder; none (`home`) when it is
 * the home folder, a folder holding it, or the filesystem root: an agent
 * working in `~` does not make the whole home folder browsable.
 */
export async function inboxThreadFilesFolder(
  thread: InboxThread,
  projectRootOf: (path: string) => Promise<InboxProjectRoot>,
  home: string | null,
): Promise<InboxFilesFolder> {
  let base: string | null = null;
  for (const message of thread.messages) if (message.author.kind === "agent") base = message.base_path ?? null;
  let root = thread.project.root;
  if (base) {
    let resolved: InboxProjectRoot;
    try {
      resolved = await projectRootOf(base);
    } catch {
      // The folder the agent worked in is gone (a removed worktree).
      return { root: null, reason: "gone" };
    }
    // A linked worktree of the project (inside it, as `.claude/worktrees/…`, or beside it): the agent's own checkout.
    // Anything else (a subfolder of the project, a nested repository): the project root.
    if (resolved.worktree !== null && resolved.root === thread.project.root) root = resolved.worktree;
  }
  const real = realOrNull(root);
  let isDir = false;
  try {
    isDir = real !== null && statSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (real === null || !isDir) return { root: null, reason: "gone" };
  const realHome = home ? realOrNull(home) : null;
  if (dirname(real) === real || (realHome !== null && isContainedPath(realHome, real))) return { root: null, reason: "home" };
  const projectReal = realOrNull(thread.project.root);
  return {
    root: real,
    project: thread.project.name,
    worktree: projectReal !== null && real !== projectReal ? basename(real) : null,
    path: displayPath(real, realHome),
  };
}

/**
 * THE CHANGE BASE of the Files view's marks: the one place to change what
 * "changed" means. Today it is the commit the thread started on, the last
 * commit of HEAD's history made before the thread's first message
 * (`git rev-list -1 --before=<first message> HEAD`); the marks are that
 * commit's tree against the working tree (commits since, staged, unstaged)
 * plus untracked files. No such commit (the repository is younger than the
 * thread): null, and the marks are against HEAD (uncommitted work only).
 */
export async function inboxFilesChangeBase(input: { root: string; threadStartedAt: string }): Promise<{ commit: string | null; source: "thread_start" | "none" }> {
  const at = Date.parse(input.threadStartedAt);
  if (!Number.isFinite(at)) return { commit: null, source: "none" };
  const answer = await runGit(["rev-list", "-1", `--before=@${Math.floor(at / 1000)}`, "HEAD"], input.root);
  const commit = answer && answer.exitCode === 0 ? answer.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(commit) ? { commit, source: "thread_start" } : { commit: null, source: "none" };
}

// --- resolving a path ------------------------------------------------------------

type Refusal = { refused: ProjectFileRefusalCode; reason?: ProjectEntryLock; size?: number };

function fromGuard(failure: RepoFileFailure): Refusal {
  return { refused: projectFileRefusalOf(failure.reason), ...(failure.size !== undefined ? { size: failure.size } : {}) };
}

/** A real path under the real root as a `/` path relative to it. */
function relativeOf(realRoot: string, real: string): string {
  return relative(realRoot, real).split(sep).join("/");
}

interface ResolvedFile {
  rel: string;
  realRel: string;
  absolutePath: string;
  realRoot: string;
}

/**
 * A file a request names, refused unless it is a readable file of the root:
 * a plain relative path, inside the root by realpath, not in `.git`, not a
 * folder, and neither a dotenv file nor under a hidden segment git tracks
 * nothing under (by the path asked for and by the file it resolves to).
 */
async function resolveFile(root: string, raw: string | null): Promise<ResolvedFile | Refusal> {
  const validated = validateRepoFilePath(raw ?? "");
  if (!validated.ok) return fromGuard(validated);
  const rel = validated.path;
  if (hasGitSegment(rel)) return { refused: "not_found" };
  const pinned = checkRepoRoot(root);
  if (!pinned.ok) return fromGuard(pinned);
  const resolved = resolveRepoFilePath(root, rel);
  if (!resolved.ok) return fromGuard(resolved);
  const realRel = relativeOf(pinned.realRoot, resolved.absolutePath);
  if (realRel === "") return { refused: "not_a_file" };
  if (hasGitSegment(realRel)) return { refused: "not_found" };
  try {
    if (statSync(resolved.absolutePath).isDirectory()) return { refused: "not_a_file" };
  } catch {
    return { refused: "not_found" };
  }
  const hidden = [...hiddenSegmentPrefixes(rel), ...hiddenSegmentPrefixes(realRel)];
  const tracked = hidden.length === 0 ? new Set<string>() : await trackedPrefixes(root, (await gitState(root, false)).git, hidden);
  const lock = projectFileLock(rel, realRel, (prefix) => tracked.has(prefix));
  if (lock) return { refused: "locked", reason: lock };
  return { rel, realRel, absolutePath: resolved.absolutePath, realRoot: pinned.realRoot };
}

interface ReadFile extends ResolvedFile {
  /** Null when the file is over the cap (`size` is then its size). */
  bytes: Uint8Array | null;
  size: number;
  mtimeMs: number;
}

/** A resolved file's bytes through the guard (by its real path, so a final symlink is the file it leads to). */
async function readFile(file: ResolvedFile, maxBytes: number): Promise<ReadFile | Refusal> {
  const read = await readRepoWorkingTreeBytes(file.realRoot, file.realRel, { maxBytes });
  if (!read.ok) {
    if (read.reason === "too-large") {
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file.absolutePath).mtimeMs;
      } catch {
        // Reported with no time.
      }
      return { ...file, bytes: null, size: read.size ?? 0, mtimeMs };
    }
    return fromGuard(read);
  }
  // The real path never ends in a symlink; one swapped in after the realpath is a refusal.
  if (read.kind !== "file") return { refused: "outside_root" };
  return { ...file, bytes: read.bytes, size: read.size, mtimeMs: read.mtimeMs };
}

interface KindDecision {
  kind: InboxAttachmentKind;
  media_type?: string;
  width?: number;
  height?: number;
}

/** The kind a file's bytes make it, decided exactly as an attachment's is (`decideInboxAttachmentKind`). */
async function decideKind(name: string, bytes: Uint8Array | null, size: number): Promise<KindDecision> {
  if (bytes === null) return { kind: "file" };
  const head = bytes.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES);
  const film = sniffInboxVideo(head);
  const video =
    film === "video/mp4" || film === "video/quicktime"
      ? await readMp4VideoMetadata(async (position, length) => bytes.subarray(position, Math.min(bytes.length, position + length)), bytes.length).catch(() => null)
      : null;
  const decided = decideInboxAttachmentKind(name, head, isInboxTextBytes(bytes), size, video);
  return {
    kind: decided.kind,
    ...(decided.media_type ? { media_type: decided.media_type } : {}),
    ...(decided.width !== undefined && decided.height !== undefined ? { width: decided.width, height: decided.height } : {}),
  };
}

// --- listing ------------------------------------------------------------------------

interface Candidate {
  name: string;
  kind: ProjectEntryKind;
  outside: boolean;
  /** The entry's real path (a symlink's target), when it is inside the root. */
  real: string | null;
}

function candidateOf(dirent: Dirent, realDir: string, realRoot: string): Candidate {
  const name = dirent.name;
  if (!dirent.isSymbolicLink()) return { name, kind: dirent.isDirectory() ? "dir" : "file", outside: false, real: join(realDir, name) };
  let real: string;
  try {
    real = realpathSync(join(realDir, name));
  } catch {
    // Dangling.
    return { name, kind: "file", outside: true, real: null };
  }
  if (!isContainedPath(real, realRoot) || hasGitSegment(relativeOf(realRoot, real))) return { name, kind: "file", outside: true, real: null };
  try {
    return { name, kind: statSync(real).isDirectory() ? "dir" : "file", outside: false, real };
  } catch {
    return { name, kind: "file", outside: true, real: null };
  }
}

type Listing = { root: { name: string; branch: string | null; git: boolean }; dir: string; entries: ProjectEntry[]; more: number };

async function listFolder(root: string, rawDir: string | null): Promise<Listing | Refusal> {
  const dir = normalizeProjectDir(rawDir);
  if (dir === null) return { refused: "invalid_path" };
  if (hasGitSegment(dir)) return { refused: "not_found" };
  const pinned = checkRepoRoot(root);
  if (!pinned.ok) return fromGuard(pinned);
  const realRoot = pinned.realRoot;
  let realDir = realRoot;
  if (dir !== "") {
    const resolved = resolveRepoFilePath(root, dir);
    if (!resolved.ok) return fromGuard(resolved);
    realDir = resolved.absolutePath;
  }
  const realDirRel = relativeOf(realRoot, realDir);
  if (hasGitSegment(realDirRel)) return { refused: "not_found" };
  let dirents: Dirent[];
  try {
    if (!statSync(realDir).isDirectory()) return { refused: "not_a_dir" };
    dirents = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return { refused: "not_found" };
  }

  const candidates = dirents.filter((d) => d.name !== ".git").map((d) => candidateOf(d, realDir, realRoot));
  candidates.sort(compareProjectEntries);
  const shown = candidates.slice(0, PROJECT_LISTING_MAX_ENTRIES);
  const state = await gitState(root, true);

  // Ignored: this folder or any folder above it, or the entry itself (by its real place).
  const join2 = (a: string, b: string) => (a === "" ? b : `${a}/${b}`);
  const ancestors: string[] = [];
  if (realDirRel !== "") {
    const parts = realDirRel.split("/");
    for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
  }
  const ignored = await ignoredPaths(root, state.git, [...ancestors, ...shown.map((c) => join2(realDirRel, c.name))]);
  const folderIgnored = ancestors.some((a) => ignored.has(a));

  // Hidden: every hidden segment of each file's path, as asked and where it really is.
  const pathsOf = (c: Candidate) => ({ asked: join2(dir, c.name), real: c.real ? relativeOf(realRoot, c.real) : join2(realDirRel, c.name) });
  const prefixes = new Set<string>();
  for (const c of shown) {
    if (c.kind !== "file" || c.outside) continue;
    const { asked, real } = pathsOf(c);
    for (const p of hiddenSegmentPrefixes(asked)) prefixes.add(p);
    for (const p of hiddenSegmentPrefixes(real)) prefixes.add(p);
  }
  const tracked = await trackedPrefixes(root, state.git, prefixes);

  const entries = shown.map((c): ProjectEntry => {
    const isIgnored = folderIgnored || ignored.has(join2(realDirRel, c.name));
    if (c.outside) return { name: c.name, kind: "file", ignored: isIgnored, locked: "outside", size: null };
    if (c.kind === "dir") return { name: c.name, kind: "dir", ignored: isIgnored, locked: null, size: null };
    const { asked, real } = pathsOf(c);
    let size: number | null = null;
    try {
      const stat = statSync(c.real!);
      size = stat.isFile() ? stat.size : null;
    } catch {
      // Gone since the listing: no size.
    }
    return { name: c.name, kind: "file", ignored: isIgnored, locked: projectFileLock(asked, real, (p) => tracked.has(p)), size };
  });
  return { root: { name: basename(realRoot), branch: state.branch, git: state.git }, dir, entries, more: candidates.length - shown.length };
}

// --- changes ------------------------------------------------------------------------

async function changedFiles(root: string, threadStartedAt: string): Promise<{ git: boolean; base: { commit: string | null; source: "thread_start" | "none" }; changes: Record<string, ProjectChangeMark>; truncated: boolean }> {
  const state = await gitState(root, false);
  if (!state.git) return { git: false, base: { commit: null, source: "none" }, changes: {}, truncated: false };
  const base = await inboxFilesChangeBase({ root, threadStartedAt });
  let against = base.commit;
  if (!against) {
    const head = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], root);
    if (head && head.exitCode === 0) against = head.stdout.trim();
    else {
      // No commit yet: everything in the index and the working tree is new.
      const empty = await runGit(["hash-object", "-t", "tree", "--stdin"], root, { input: "" });
      against = empty && empty.exitCode === 0 ? empty.stdout.trim() : null;
    }
  }
  const timeoutMs = INBOX_FILES_CHANGES_GIT_TIMEOUT_MS;
  let truncated = false;
  const marks = new Map<string, ProjectChangeMark>();
  if (against) {
    const diff = await runGit(["diff", "--name-status", "-z", "--no-renames", "--relative", against, "--"], root, { timeoutMs });
    if (diff && diff.exitCode === 0) {
      const parsed = parseNameStatusZ(diff.stdout);
      for (const [path, mark] of parsed.changes) marks.set(path, mark);
      truncated = parsed.truncated || diff.stopped;
    }
  }
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], root, {
    timeoutMs,
    onRecord: (path) => {
      if (marks.size >= PROJECT_CHANGES_MAX) {
        truncated = true;
        return true;
      }
      if (path !== "" && !marks.has(path)) marks.set(path, "U");
      return false;
    },
  });
  if (untracked?.stopped) truncated = true;
  return { git: true, base, changes: Object.fromEntries(marks), truncated };
}

// --- routes ---------------------------------------------------------------------------

export interface InboxFilesRoutesContext {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** The attachment routes' HTML asset registry (`createInboxAttachmentRoutes(...).htmlAssets`): one registry for the Inbox. */
  htmlAssets: { rewriteHtml(html: string, htmlFilePath: string): string };
  /** The project root of a folder (packages/server/inbox-project-root.ts), cached by the server. */
  projectRootOf: (path: string) => Promise<InboxProjectRoot>;
  /** The person's home folder (the Inbox's agent environment's): never browsable, nor any folder holding it. */
  home: string | null;
}

const ROUTE = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/files(?:\/(folder|content|raw|changed|annotations))?$/;

export function createInboxFilesRoutes(context: InboxFilesRoutesContext) {
  const { store, serverSession } = context;

  const refuse = (refusal: Refusal): Response =>
    json(
      {
        error: refusal.refused,
        code: refusal.refused,
        serverSession,
        ...(refusal.reason ? { reason: refusal.reason } : {}),
        ...(refusal.size !== undefined ? { size: refusal.size } : {}),
      },
      PROJECT_FILE_REFUSAL_STATUS[refusal.refused],
    );
  const noFolder = (reason: "home" | "gone") => json({ error: "files_no_folder", code: "files_no_folder", reason, serverSession }, 404);
  const folderOf = (thread: InboxThread) => inboxThreadFilesFolder(thread, context.projectRootOf, context.home);

  /**
   * Answers a request on one of these routes, or null when the path is not
   * one of them. `via` is where it came in; the tailnet reaches these routes
   * like the window's own port (reads, and comments through the Inbox's
   * same-origin write guard), never anything beyond them.
   */
  return async function handle(req: Request, url: URL, _via: "local" | "tailnet" = "local"): Promise<Response | null> {
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    const threadId = match[1]!;
    const route = (match[2] ?? "list") as "list" | "folder" | "content" | "raw" | "changed" | "annotations";

    if (route === "annotations") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await context.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      const thread = store.thread(threadId);
      if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      const folder = await folderOf(thread);
      if (folder.root === null) return noFolder(folder.reason);
      const root = folder.root;
      const file = await resolveFile(root, typeof body.path === "string" ? body.path : null);
      if ("refused" in file) return refuse(file);
      const read = await readFile(file, INBOX_VIEW_MAX_BYTES);
      if ("refused" in read) return refuse(read);
      const { kind } = await decideKind(basename(read.absolutePath), read.bytes, read.size);
      // A download (a PDF, a binary, text too large to show) takes no comments; nor does a film here.
      if (!isInboxAnnotatableKind(kind) || kind === "video") {
        throw new InboxError("annotation_not_allowed", `annotation: ${basename(read.rel)} takes no annotations here.`, { field: "path" });
      }
      return json({ annotation: store.saveProjectFileAnnotation({ threadId, rel: read.rel, realpath: read.absolutePath, annotation: body.annotation }) });
    }

    if (req.method !== "GET" && !(route === "raw" && req.method === "HEAD")) return json({ error: "Use GET." }, 405);
    if (crossSite(req)) return json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, 403);
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const folder = await folderOf(thread);
    // Which folder (the window's folder button and label), or why none: no listing, no read.
    if (route === "folder") {
      if (folder.root === null) return json({ serverSession, folder: null, reason: folder.reason });
      return json({ serverSession, folder: { name: basename(folder.root), project: folder.project, worktree: folder.worktree, path: folder.path } });
    }
    if (folder.root === null) return noFolder(folder.reason);
    const root = folder.root;

    if (route === "list") {
      const listing = await listFolder(root, url.searchParams.get("dir"));
      if ("refused" in listing) return refuse(listing);
      return json({ serverSession, ...listing, root: { ...listing.root, project: folder.project, worktree: folder.worktree, path: folder.path } });
    }

    if (route === "changed") {
      return json({ serverSession, ...(await changedFiles(root, thread.messages[0]?.created_at ?? "")) });
    }

    const file = await resolveFile(root, url.searchParams.get("path"));
    if ("refused" in file) return refuse(file);

    if (route === "content") {
      const read = await readFile(file, INBOX_VIEW_MAX_BYTES);
      if ("refused" in read) return refuse(read);
      const decided = await decideKind(basename(read.absolutePath), read.bytes, read.size);
      const text = read.bytes !== null && isInboxTextKind(decided.kind) ? Buffer.from(read.bytes).toString("utf8") : null;
      return json({
        serverSession,
        path: read.rel,
        name: basename(read.rel),
        kind: decided.kind,
        size: read.size,
        mtime: new Date(read.mtimeMs).toISOString(),
        sha256: read.bytes !== null ? createHash("sha256").update(read.bytes).digest("hex") : null,
        text,
        // The page as the attachment view serves it: a <base href> at its own folder's asset route.
        html: decided.kind === "html" && text !== null ? context.htmlAssets.rewriteHtml(text, read.absolutePath) : null,
        ...(decided.media_type ? { media_type: decided.media_type } : {}),
        ...(decided.width !== undefined ? { width: decided.width, height: decided.height } : {}),
      });
    }

    // raw
    const read = await readFile(file, INBOX_FILES_RAW_MAX_BYTES);
    if ("refused" in read) return refuse(read);
    if (read.bytes === null) return refuse({ refused: "too_large", size: read.size });
    const bytes = read.bytes;
    const head = bytes.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES);
    // The kind as the content route decides it; the type from the bytes, sniffed now (never the name's).
    const { kind } = await decideKind(basename(read.absolutePath), bytes, read.size);
    const contentType =
      (kind === "image" ? sniffImageContentType(head) : kind === "video" ? sniffInboxVideo(head) : kind === "pdf" && isPdfHead(head) ? "application/pdf" : null) ??
      "application/octet-stream";
    const inline = contentType !== "application/octet-stream" && url.searchParams.get("download") !== "1";
    // A file read is backed by a plain ArrayBuffer (never shared), which is what a Response body takes.
    return new Response(req.method === "HEAD" ? null : (bytes as Uint8Array<ArrayBuffer>), {
      headers: {
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Type": contentType,
        "Content-Security-Policy": inline ? INBOX_MESSAGE_IMAGE_CSP : "sandbox",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", basename(read.rel)),
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-cache",
      },
    });
  };
}
