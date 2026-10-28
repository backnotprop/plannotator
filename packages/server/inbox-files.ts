/**
 * Plannotator Inbox: Files, the thread's project folder browsed and
 * commented on from the window (Bun only; mounted beside the attachment
 * routes in packages/server/inbox.ts, behind the Inbox's Host, Origin and
 * same-origin guards).
 *
 *   GET  /api/inbox/threads/:id/files/folder        which folder, or why none (no listing)
 *   GET  /api/inbox/threads/:id/files?dir=          one folder level
 *   GET  /api/inbox/threads/:id/files/levels?dir=&dir=  several levels at once (the window's refresh)
 *   GET  /api/inbox/threads/:id/files/content?path= a file for the viewers
 *   GET  /api/inbox/threads/:id/files/raw?path=     its bytes (img, video, Download)
 *   GET  /api/inbox/threads/:id/files/changed       change marks since the thread began
 *   POST /api/inbox/threads/:id/files/annotations   a comment on a file
 *
 * The files root is the folder the thread's latest agent message was sent
 * from, taken to its project root, or to its linked worktree when that is
 * where the agent works; never the home folder, a folder holding it, or `/`
 * ({@link inboxThreadFilesFolder}). Every read goes through the Inbox's own
 * guard (packages/server/inbox-files-guard.ts: a plain relative path,
 * symlinks followed as VS Code follows them, `.git` never reached, a FIFO
 * never waited on, a byte cap); the listing and lock rules are
 * packages/shared/project-listing.ts. Names are browsable; a dotenv file's
 * contents are never served. The routes answer on this computer only: a
 * request that came in over the tailnet is refused (`403 local_only`), and so
 * is a request another site makes, before anything is read. Every refusal is
 * a short code; the window owns the words.
 */

import { createHash } from "node:crypto";
import { readdirSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_VIEW_MAX_BYTES, isInboxAnnotatableKind, isInboxTextBytes, isInboxTextKind, type InboxAttachmentKind, type InboxThread } from "@plannotator/core/inbox-types";
import {
  compareProjectEntries,
  hasGitSegment,
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
import { openFilesFile, reachesGit, readFilesFile, resolveFilesPath, type FilesGuardFailure } from "./inbox-files-guard";
import { byteRangeResponse, decideByteRange } from "./inbox-byte-range";
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

/** How long a folder's git state (a repository? which branch?) is used again before git is asked anew. */
const GIT_STATE_TTL_MS = 10_000;
const gitStates = new Map<string, { at: number; state: Promise<GitState> }>();

async function askGitState(root: string): Promise<GitState> {
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], root);
  if (!inside || inside.exitCode !== 0 || inside.stdout.trim() !== "true") return { git: false, branch: null };
  const branch = await runGit(["symbolic-ref", "--short", "-q", "HEAD"], root);
  const name = branch && branch.exitCode === 0 ? branch.stdout.trim() : "";
  return { git: true, branch: name || null };
}

/** Whether the folder is a git work tree, and its branch: two git runs at most every 10 s per folder. */
function gitState(root: string): Promise<GitState> {
  const now = Date.now();
  const cached = gitStates.get(root);
  if (cached && now - cached.at < GIT_STATE_TTL_MS) return cached.state;
  const state = askGitState(root);
  gitStates.set(root, { at: now, state });
  if (gitStates.size > 200) gitStates.delete(gitStates.keys().next().value!);
  return state;
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

/** True when `candidate` is `root` or lies under it (both real paths). */
function isContainedPath(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

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

function fromGuard(failure: FilesGuardFailure): Refusal {
  return { refused: projectFileRefusalOf(failure.reason) };
}

/** A real path under the real root as a `/` path relative to it, or null when it is not under it (a symlink out). */
function relativeOf(realRoot: string, real: string): string | null {
  if (real === realRoot) return "";
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  return real.startsWith(prefix) ? relative(realRoot, real).split(sep).join("/") : null;
}

interface ResolvedFile {
  /** The path as asked for, relative to the folder. */
  rel: string;
  /** Where it resolves to, every symlink followed. */
  absolutePath: string;
}

/**
 * A file a request names, refused unless it is a readable file: a plain
 * relative path, not in `.git` (as asked or where it leads), not a folder,
 * and not a dotenv file (by the name asked for and by the file it resolves
 * to). Symlinks are followed wherever they lead, as VS Code follows them.
 */
function resolveFile(root: string, raw: string | null): ResolvedFile | Refusal {
  if (raw === null || raw === "") return { refused: "invalid_path" };
  const resolved = resolveFilesPath(root, raw);
  if (!resolved.ok) return fromGuard(resolved);
  if (resolved.rel === "") return { refused: "not_a_file" };
  const lock = projectFileLock(resolved.rel, resolved.real);
  if (lock) return { refused: "locked", reason: lock };
  return { rel: resolved.rel, absolutePath: resolved.real };
}

interface ReadFile extends ResolvedFile {
  /** Null when the file is over the cap (`size` is then its size). */
  bytes: Uint8Array | null;
  size: number;
  mtimeMs: number;
}

/** A resolved file's bytes through the guard (`readFilesFile`: no FIFO waited on, a regular file proved by its descriptor, a cap). */
async function readFile(file: ResolvedFile, maxBytes: number): Promise<ReadFile | Refusal> {
  const read = await readFilesFile(file.absolutePath, maxBytes);
  if (!read.ok) return fromGuard(read);
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
  /** Where the entry resolves to (a symlink followed), or null when it leads nowhere. */
  real: string | null;
  /** It resolves into a repository's `.git`: listed, never read or opened. */
  git: boolean;
}

function candidateOf(dirent: Dirent, realDir: string, realRoot: string): Candidate {
  const name = dirent.name;
  if (!dirent.isSymbolicLink()) return { name, kind: dirent.isDirectory() ? "dir" : "file", real: join(realDir, name), git: false };
  let real: string;
  try {
    real = realpathSync(join(realDir, name));
  } catch {
    // Dangling: a file that does not open.
    return { name, kind: "file", real: null, git: false };
  }
  if (reachesGit(realRoot, real)) return { name, kind: "file", real, git: true };
  try {
    return { name, kind: statSync(real).isDirectory() ? "dir" : "file", real, git: false };
  } catch {
    return { name, kind: "file", real: null, git: false };
  }
}

/** One listed folder level, or why not. */
type Level = { dir: string; entries: ProjectEntry[]; more: number } | ({ dir: string } & Refusal);

/** A folder level's entries before git marks them: refused, or read and cut at the cap. */
function readLevel(root: string, rawDir: string | null): { dir: string; realDir: string; candidates: Candidate[]; more: number } | ({ dir: string } & Refusal) {
  const asked = rawDir ?? "";
  const resolved = resolveFilesPath(root, rawDir);
  if (!resolved.ok) return { dir: asked, ...fromGuard(resolved) };
  let dirents: Dirent[];
  try {
    if (!statSync(resolved.real).isDirectory()) return { dir: resolved.rel, refused: "not_a_dir" };
    dirents = readdirSync(resolved.real, { withFileTypes: true });
  } catch {
    return { dir: resolved.rel, refused: "not_found" };
  }
  // Cut at the cap BEFORE any symlink is resolved (a folder of 20k links must not cost 20k realpaths): ordered by what
  // the entry says of itself (a link counts as a file), then only the kept links are followed and the kept rows
  // ordered again by what they lead to. A linked folder past the cap in a huge folder stays cut, as a file would.
  const all = dirents.filter((d) => d.name !== ".git");
  const kept = all
    .map((dirent) => ({ dirent, name: dirent.name, kind: (dirent.isDirectory() ? "dir" : "file") as ProjectEntryKind }))
    .sort(compareProjectEntries)
    .slice(0, PROJECT_LISTING_MAX_ENTRIES);
  const candidates = kept.map((k) => candidateOf(k.dirent, resolved.real, resolved.realRoot));
  candidates.sort(compareProjectEntries);
  return { dir: resolved.rel, realDir: resolved.real, candidates, more: Math.max(0, all.length - PROJECT_LISTING_MAX_ENTRIES) };
}

type Listing = { root: { name: string; branch: string | null; git: boolean }; levels: Level[] };

/**
 * Several folder levels in one answer: one cached git state and one
 * `check-ignore` for all of them, so the window's refresh costs one git run
 * however many folders are open. A level reached through a symlink out of
 * the folder is listed with nothing marked ignored (git does not judge it).
 */
async function listFolders(root: string, rawDirs: readonly (string | null)[]): Promise<Listing | Refusal> {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { refused: "not_found" };
  }
  const state = await gitState(realRoot);
  const join2 = (a: string, b: string) => (a === "" ? b : `${a}/${b}`);
  // Each folder once, and never more than INBOX_FILES_LEVELS_MAX_ENTRIES rows in one answer: a level whose rows would
  // pass it is refused `too_large` (a smaller one after it may still fit), and once the answer is full the rest are
  // not read. The window sends the levels refused last time first on its next refresh, so none stays stale.
  const seen = new Set<string>();
  let rows = 0;
  const read: ReturnType<typeof readLevel>[] = [];
  for (const dir of rawDirs) {
    const key = normalizeProjectDir(dir) ?? `\u0000${dir ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tooLarge = { dir: normalizeProjectDir(dir) ?? dir ?? "", refused: "too_large" as const };
    if (rows >= INBOX_FILES_LEVELS_MAX_ENTRIES) {
      read.push(tooLarge);
      continue;
    }
    const level = readLevel(realRoot, dir);
    if (!("refused" in level)) {
      if (rows + level.candidates.length > INBOX_FILES_LEVELS_MAX_ENTRIES) {
        read.push({ ...tooLarge, dir: level.dir });
        continue;
      }
      rows += level.candidates.length;
    }
    read.push(level);
  }
  // Every path git is asked about: each level's folders above it, and its entries, where they really are.
  const ask = new Set<string>();
  const plans = read.map((level) => {
    if ("refused" in level) return null;
    const realDirRel = relativeOf(realRoot, level.realDir);
    if (realDirRel === null) return { level, realDirRel, ancestors: [] as string[] };
    const ancestors: string[] = [];
    if (realDirRel !== "") {
      const parts = realDirRel.split("/");
      for (let i = 1; i <= parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
    }
    for (const a of ancestors) ask.add(a);
    for (const c of level.candidates) ask.add(join2(realDirRel, c.name));
    return { level, realDirRel, ancestors };
  });
  const ignored = await ignoredPaths(realRoot, state.git, [...ask]);
  const levels = read.map((level, i): Level => {
    if ("refused" in level) return level;
    const plan = plans[i]!;
    const folderIgnored = plan.ancestors.some((a) => ignored.has(a));
    const entries = level.candidates.map((c): ProjectEntry => {
      const isIgnored = plan.realDirRel !== null && (folderIgnored || ignored.has(join2(plan.realDirRel, c.name)));
      if (c.git) return { name: c.name, kind: "file", ignored: isIgnored, locked: "git", size: null };
      if (c.kind === "dir") return { name: c.name, kind: "dir", ignored: isIgnored, locked: null, size: null };
      let size: number | null = null;
      if (c.real) {
        try {
          const stat = statSync(c.real);
          size = stat.isFile() ? stat.size : null;
        } catch {
          // Gone since the listing: no size.
        }
      }
      return { name: c.name, kind: "file", ignored: isIgnored, locked: projectFileLock(join2(level.dir, c.name), c.real ?? c.name), size };
    });
    return { dir: level.dir, entries, more: level.more };
  });
  return { root: { name: basename(realRoot), branch: state.branch, git: state.git }, levels };
}

/** At most this many levels in one `levels` request. */
export const INBOX_FILES_LEVELS_MAX = 300;
/** At most this many rows in one `levels` answer (five full levels); a level that would pass it is refused `too_large`. */
export const INBOX_FILES_LEVELS_MAX_ENTRIES = 25_000;

// --- changes ------------------------------------------------------------------------

async function changedFiles(root: string, threadStartedAt: string): Promise<{ git: boolean; base: { commit: string | null; source: "thread_start" | "none" }; changes: Record<string, ProjectChangeMark>; truncated: boolean }> {
  const state = await gitState(root);
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

/**
 * A project file's raw type, decided from its bytes as the content route decides its kind, and remembered by file
 * version (device, inode, size, mtime) so a player's range requests do not read the whole file again each time.
 */
const rawTypes = new Map<string, { contentType: string; etag: string }>();
async function rawTypeOf(handle: FileHandle, stat: Stats, name: string): Promise<{ contentType: string; etag: string }> {
  const key = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const known = rawTypes.get(key);
  if (known) return known;
  const bytes = Buffer.alloc(stat.size);
  let read = 0;
  while (read < stat.size) {
    const { bytesRead } = await handle.read(bytes, read, stat.size - read, read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  const body = bytes.subarray(0, read);
  const head = body.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES);
  const { kind } = await decideKind(name, body, read);
  const contentType =
    (kind === "image" ? sniffImageContentType(head) : kind === "video" ? sniffInboxVideo(head) : kind === "pdf" && isPdfHead(head) ? "application/pdf" : null) ??
    "application/octet-stream";
  const answer = { contentType, etag: `"${createHash("sha256").update(key).digest("hex").slice(0, 32)}"` };
  rawTypes.set(key, answer);
  if (rawTypes.size > 200) rawTypes.delete(rawTypes.keys().next().value!);
  return answer;
}

const ROUTE = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/files(?:\/(folder|levels|content|raw|changed|annotations))?$/;

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
   * one of them. `via` is where it came in: over the tailnet every route
   * answers `403 local_only`.
   */
  return async function handle(req: Request, url: URL, via: "local" | "tailnet" = "local"): Promise<Response | null> {
    const match = ROUTE.exec(url.pathname);
    if (!match) return null;
    // The project folder is read on this computer only (a reviewer's call, the safe default; the owner can open it up).
    if (via === "tailnet") return json({ error: "The project folder opens only on this computer, not over the tailnet.", code: "local_only", serverSession }, 403);
    const threadId = match[1]!;
    const route = (match[2] ?? "list") as "list" | "levels" | "folder" | "content" | "raw" | "changed" | "annotations";

    if (route === "annotations") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await context.readBody(req);
      if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      const thread = store.thread(threadId);
      if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      const folder = await folderOf(thread);
      if (folder.root === null) return noFolder(folder.reason);
      const root = folder.root;
      const file = resolveFile(root, typeof body.path === "string" ? body.path : null);
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

    const rootOf = (listing: Listing) => ({ ...listing.root, project: folder.project, worktree: folder.worktree, path: folder.path });
    if (route === "list") {
      const listing = await listFolders(root, [url.searchParams.get("dir")]);
      if ("refused" in listing) return refuse(listing);
      const level = listing.levels[0]!;
      if ("refused" in level) return refuse(level);
      return json({ serverSession, root: rootOf(listing), dir: level.dir, entries: level.entries, more: level.more });
    }
    if (route === "levels") {
      const dirs = url.searchParams.getAll("dir");
      if (dirs.length === 0 || dirs.length > INBOX_FILES_LEVELS_MAX) return refuse({ refused: "invalid_path" });
      const listing = await listFolders(root, dirs);
      if ("refused" in listing) return refuse(listing);
      return json({ serverSession, root: rootOf(listing), levels: listing.levels });
    }

    if (route === "changed") {
      return json({ serverSession, ...(await changedFiles(root, thread.messages[0]?.created_at ?? "")) });
    }

    const file = resolveFile(root, url.searchParams.get("path"));
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

    // raw: through the guard's open, answering Range (a player's probe and seeks, Safari's `bytes=0-1`) from the descriptor.
    const opened = await openFilesFile(file.absolutePath);
    if (!opened.ok) return refuse(fromGuard(opened));
    const { handle, stat } = opened;
    let contentType: string;
    let etag: string;
    try {
      if (stat.size > INBOX_FILES_RAW_MAX_BYTES) {
        await handle.close().catch(() => undefined);
        return refuse({ refused: "too_large", size: stat.size });
      }
      ({ contentType, etag } = await rawTypeOf(handle, stat, basename(file.absolutePath)));
    } catch {
      await handle.close().catch(() => undefined);
      return refuse({ refused: "not_found" });
    }
    const inline = contentType !== "application/octet-stream" && url.searchParams.get("download") !== "1";
    const decision = decideByteRange(req.headers.get("range"), stat.size, { ifRange: req.headers.get("if-range"), etag });
    return byteRangeResponse(
      handle,
      stat.size,
      decision,
      {
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Type": contentType,
        "Content-Security-Policy": inline ? INBOX_MESSAGE_IMAGE_CSP : "sandbox",
        "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", basename(file.rel)),
        "Cache-Control": "private, no-cache",
        ETag: etag,
      },
      { head: req.method === "HEAD" },
    );
  };
}
