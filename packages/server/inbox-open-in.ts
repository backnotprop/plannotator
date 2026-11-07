/**
 * Plannotator Inbox: "Open in" for attachments (design record
 * "inbox-open-in", approved 2026-10-14). Two routes, both on this computer
 * only (`403 local_only` through the tailnet, and never on the phone's
 * device door, whose allowlist does not name them):
 *
 *   GET  /api/inbox/open-in/apps  the editors and the file manager this host has
 *   POST /api/inbox/open-in       { attachment_id, app_id, serverSession }
 *   GET  /api/inbox/open-in/file  ?path=&<scope>  a referenced file: is it here, and what kind
 *   POST /api/inbox/open-in/file  { path, line?, <scope>, app_id, serverSession }
 *   GET  /api/inbox/open-in/file/code  ?path=&<scope>  a referenced file's text, for its hover
 *   GET  /api/inbox/open-in/file/view  ?path=&thread=&message=  a file a message names, for the pane (any kind)
 *   GET  /api/inbox/open-in/file/raw   ?path=&thread=&message=  that file's bytes, when it is an image or a film
 *   POST /api/inbox/open-in/file/attach  { path, thread, message, serverSession }  attach it to the message (a comment)
 *
 * The view, raw and attach routes (approval "inbox-file-refs-open-viewer") are not behind Code review and not held to
 * the project: any file on this computer the Inbox can read, but never a secret (`secretOrSystem`, the dotenv family).
 *
 * The last only reads, so it also answers the owner through the tailnet (a phone's tap). A thread that owns a pull
 * request, and a PR page (`pull`), read the file at that PR's head commit from the forge (`InboxPulls.file`), so it needs
 * no checkout; otherwise, and when the PR has no such file, it is the file on this computer, under the rules below.
 *
 * The launch takes an attachment id, never a path: the path is the record's
 * realpath, re-checked at launch (`checkInboxAttachmentForLaunch`: still that
 * file, the named symlink still pointing there, a regular file, not the
 * dotenv family, and an image or PDF still that kind by its bytes). The
 * per-kind policy (`inboxOpenInPolicy`) decides what may open it; the OS
 * default handler only ever runs through an explicit `app_id: "default"`
 * the policy allows, never as a fallback. Same-origin is the Inbox's global
 * POST guard; the stale-tab guard is checked here.
 *
 * A referenced file (Shape's references, a review's diff headers; while Code
 * review is on) is not a record, so its route takes a project-relative path and
 * a scope, never a root: `thread` (with `message`, the message's own project
 * first; with `from: "root"` for a diff's path), `shape`, or `repo` (a PR page: `host/owner/repo`, every clone here).
 * The server finds the roots and `checkInboxProjectFile` holds the path to them.
 * A path out of the project is refused at launch and reads as not found.
 *
 * The launcher is a seam (`InboxOpenInLauncher`): tests pass a recording one
 * and never start a real app.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInAllows, inboxOpenInPolicy } from "@plannotator/core/inbox-types";
import { getOpenInApp, type OpenInApp, type OpenInPlatform } from "@plannotator/core/open-in-apps";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import {
  checkInboxAttachmentForLaunch,
  checkInboxProjectFile,
  checkInboxReadableFile,
  inboxAttachmentState,
  inboxStatEtag,
  recordInboxAttachments,
  type InboxProjectFilePlace,
} from "@plannotator/shared/inbox/attachments";
import { readFileCapped } from "@plannotator/shared/repo-file";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { sniffInboxVideo } from "@plannotator/shared/inbox/video";
import type { FileHandle } from "node:fs/promises";
import { INBOX_UPLOAD_MAX_BYTES, INBOX_VIEW_MAX_BYTES, inboxAttachmentKind, inboxAttachmentNameRefusal, isInboxAnnotatableKind, isInboxTextKind } from "@plannotator/core/inbox-types";
import { byteRangeResponse, decideByteRange } from "./inbox-byte-range";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { isShapeProjectPath } from "@plannotator/core/shape";
import { crossOriginRefusalBody, isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { isLinkedWorktree } from "@plannotator/shared/shape/store";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import {
  currentPlatform,
  getAvailableOpenInApps,
  openWithApp,
  openWithSystemDefault,
  revealFile,
  type AvailableOpenInApp,
  type OpenInLaunchResult,
} from "./open-in";
import type { InboxPullFile } from "./inbox-pulls";

export const INBOX_OPEN_IN_PATH = "/api/inbox/open-in";
export const INBOX_OPEN_IN_APPS_PATH = "/api/inbox/open-in/apps";
export const INBOX_OPEN_IN_FILE_PATH = "/api/inbox/open-in/file";
export const INBOX_OPEN_IN_CODE_PATH = "/api/inbox/open-in/file/code";
/**
 * A file an agent's message names, for the pane (approval "inbox-file-refs-open-viewer"): its text or kind, an image's
 * or a film's bytes, and making it one of the message's attachments when the person comments on it. Not behind Code
 * review, and not held to the project: any file on this computer the Inbox can read, but never a secret.
 */
export const INBOX_OPEN_IN_VIEW_PATH = "/api/inbox/open-in/file/view";
export const INBOX_OPEN_IN_RAW_PATH = "/api/inbox/open-in/file/raw";
export const INBOX_OPEN_IN_ATTACH_PATH = "/api/inbox/open-in/file/attach";

/** How the Inbox launches: the host's real launcher, or a test's stub. */
export interface InboxOpenInLauncher {
  platform: OpenInPlatform;
  /** The catalog apps installed here (always the file manager). */
  apps: () => AvailableOpenInApp[];
  reveal: (path: string) => Promise<OpenInLaunchResult>;
  openWithApp: (app: OpenInApp, path: string, line?: number) => Promise<OpenInLaunchResult>;
  openWithSystemDefault: (path: string) => Promise<OpenInLaunchResult>;
}

/** The launcher of packages/server/open-in.ts. Apps are detected once per process. */
export function systemOpenInLauncher(): InboxOpenInLauncher {
  let detected: AvailableOpenInApp[] | null = null;
  return {
    platform: currentPlatform(),
    apps: () => (detected ??= getAvailableOpenInApps()),
    reveal: revealFile,
    openWithApp,
    openWithSystemDefault,
  };
}

/** The apps the Inbox offers: the file manager and the editors (never a terminal). */
function inboxApps(launcher: InboxOpenInLauncher): AvailableOpenInApp[] {
  return launcher.apps().filter((app) => app.kind === "file-manager" || app.kind === "editor");
}

export interface InboxOpenInRouteContext {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  localOnly: () => Response;
  launcher: InboxOpenInLauncher;
  /** The Settings → Capabilities switch a referenced file's route sits behind. */
  codeReviewOn: () => boolean;
  /** A shape's project folder, or null when there is no such shape (or Shape is off). */
  shapeRoot: (id: string) => string | null;
  /** The folders of every project on a repository (`host/owner/repo`, lowercased). */
  repoRoots: (repo: string) => string[];
  /** The pull requests a thread owns, the latest hand-over first. */
  threadPulls: (thread: string) => string[];
  /** A file at a pull request's head commit, or null. */
  pullFile: (pull: string, path: string) => Promise<InboxPullFile | null>;
  /** This computer's window, or the owner's own login through the tailnet. */
  ownerOrLocal: (req: Request, via: "local" | "tailnet") => boolean;
  /** The person's home folder, by default this process's. */
  home?: string;
}

/**
 * The checkout a folder lies in: the nearest folder up with a `.git`, from a folder that may be gone (a branch switch
 * removes a subfolder, the worktree stays). The home folder is never one, even with a `.git`: it holds more than code.
 */
function checkoutOf(folder: string, home: string): string | null {
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return realpathOrNull(dir) === home ? null : dir;
    if (dirname(dir) === dir) return null;
  }
}

/** `path` from `root`, with forward slashes, when it lies inside `root`. */
function pathInside(root: string, path: string): string | null {
  const inside = relative(root, path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  return inside.split(sep).join("/");
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

interface FileScope {
  thread?: unknown;
  message?: unknown;
  shape?: unknown;
  repo?: unknown;
  /** A PR page: the pull request whose version of a file its hover shows. */
  pull?: unknown;
  /** `root`: a diff's path, which starts at the top of the repository wherever the agent stood. */
  from?: unknown;
}

const CREDENTIAL_FOLDERS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".docker", ".kube", ".git", ".password-store"]);
const CREDENTIAL_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".bash_history",
  ".zsh_history",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);
/** A run of folders and names that holds a CLI's sign-in, anywhere in the path. */
const CREDENTIAL_RUNS = [".config/gh", ".config/glab-cli", ".config/gcloud", ".config/op", ".local/share/keyrings", "library/keychains", ".codex/auth.json", ".claude/.credentials.json", ".claude.json"];

/**
 * A path a hover never shows, as if the file were missing: a thread sent from the home folder makes all of it a project.
 * Other hidden folders (`.github`, `.claude`) are ordinary project files. NTFS names are cleaned as for a dotenv file.
 */
function holdsCredentials(path: string): boolean {
  const parts = path.replace(/\\/g, "/").toLowerCase().split("/").map((part) => part.replace(/:.*$/s, "").replace(/[. ]+$/, ""));
  const name = parts.at(-1) ?? "";
  const joined = `/${parts.join("/")}/`;
  return (
    parts.some((part) => CREDENTIAL_FOLDERS.has(part)) ||
    CREDENTIAL_FILES.has(name) ||
    /\.(pem|key)$/.test(name) ||
    CREDENTIAL_RUNS.some((run) => joined.includes(`/${run}/`))
  );
}

/**
 * A path a referenced file's view never shows or attaches, wherever it is: a secret (`holdsCredentials`; the dotenv
 * family is refused by `checkInboxReadableFile` itself), or a live system file (`/proc`, `/sys`, `/dev`).
 */
function secretOrSystem(path: string): boolean {
  return holdsCredentials(path) || /^\/(?:proc|sys|dev)(?:\/|$)/.test(path.replace(/\\/g, "/"));
}

/** Of Plannotator's data folder, what holds documents a message may name: saved plans, plan history, guides, shapes. */
const PLANNOTATOR_DOCUMENTS = new Set(["plans", "history", "guides", "shapes"]);

/**
 * Plannotator's own state, which no view or hover shows: everything in its data folder but `PLANNOTATOR_DOCUMENTS`.
 * That is the Inbox's tokens and secrets (`inbox/machines.json`, `inbox/relay.json`, `inbox/device-secrets/`,
 * `inbox/inbox.json`, its TLS key and voice key), every thread's log, launched agents' homes, and session files.
 * `dataDirs` are the folder in use and `~/.plannotator`, as given and at their realpaths; compared without case.
 */
export function isPlannotatorState(path: string, dataDirs: readonly string[]): boolean {
  const at = path.replace(/\\/g, "/").toLowerCase();
  return dataDirs.some((dir) => {
    const root = dir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (at === root) return false;
    if (!at.startsWith(`${root}/`)) return false;
    const first = at.slice(root.length + 1).split("/")[0] ?? "";
    return !PLANNOTATOR_DOCUMENTS.has(first);
  });
}

/** A text file's contents from the handle that was checked, at most `maxBytes`; null past it, or not UTF-8 text. */
async function readTextFrom(handle: FileHandle, size: number, maxBytes: number): Promise<{ ok: true; content: string } | { ok: false }> {
  if (size > maxBytes) return { ok: false };
  const buffer = Buffer.alloc(size + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > maxBytes) return { ok: false };
  return { ok: true, content: new TextDecoder("utf-8").decode(buffer.subarray(0, length)) };
}

/** A PR file's kind by its name (its bytes are text: the forge's read is text only). */
function kindOfName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "txt" || ext === "log") return "text";
  return "code";
}

export function createInboxOpenInRoute(context: InboxOpenInRouteContext) {
  const { store, serverSession, readBody, json, localOnly, launcher, codeReviewOn, shapeRoot, repoRoots, threadPulls, pullFile, ownerOrLocal } = context;
  const givenHome = context.home ?? homedir();
  const home = realpathOrNull(givenHome) ?? givenHome;
  const dataDirs = [...new Set([dirname(store.dir), join(givenHome, ".plannotator")].flatMap((dir) => [dir, realpathOrNull(dir) ?? dir]))];
  /** What a referenced file's view, raw read and attach refuse: a secret, a live system file, Plannotator's own state. */
  const refusedHere = (path: string): boolean => secretOrSystem(path) || isPlannotatorState(path, dataDirs);

  /**
   * Where a scope's path may be, in the order to try. A shape's or a repository's path starts at its root, and so does
   * a diff's (`from: "root"`). A message's link is as the agent wrote it, so it starts in the checkout the agent wrote
   * from: at its folder (`base_path`), then at that checkout's top. Other projects come after, except that an agent in a
   * linked worktree never falls back to the main checkout: that copy is not the agent's file. An absolute path says
   * which of these it means.
   */
  const placesOf = (scope: FileScope, named: string): InboxProjectFilePlace[] => {
    if (typeof scope.shape === "string") {
      const root = shapeRoot(scope.shape);
      return root ? [{ root, relative: named }] : [];
    }
    if (typeof scope.repo === "string") return repoRoots(scope.repo.toLowerCase()).map((root) => ({ root, relative: named }));
    if (typeof scope.thread !== "string") return [];
    const first = store.message(scope.thread);
    if (!first || first.thread_id !== scope.thread) return [];
    const message = typeof scope.message === "string" ? store.message(scope.message) : null;
    const sender = message?.thread_id === scope.thread ? message : first;
    const base = sender.base_path ?? null;
    const checkout = base ? checkoutOf(base, home) : null;
    const own = sender.from_project?.root ?? store.project(sender.project_id)?.root ?? null;
    const shown = [store.project(first.project_id)?.root, store.thread(scope.thread)?.project.root];
    const known = (roots: unknown[]) => [...new Set(roots.filter((root): root is string => typeof root === "string"))];
    if (isAbsolute(named)) {
      const roots = known([checkout, own, ...shown]);
      const real = realpathOrNull(named);
      const places = roots.flatMap((root) => {
        const inside = pathInside(root, named) ?? (real ? pathInside(root, real) : null);
        return inside ? [{ root, relative: inside }] : [];
      });
      // Outside all of them: refused by the path rule, as any other path outside the project.
      return places.length || !roots.length ? places : [{ root: roots[0]!, relative: named }];
    }
    const roots = known(checkout && isLinkedWorktree(checkout) ? [checkout, ...shown.filter((root) => root !== own)] : [checkout, own, ...shown]);
    const clean = posix.normalize(named.replace(/\\/g, "/"));
    return roots.flatMap((root) => {
      const from = base && scope.from !== "root" ? (base === root ? "" : pathInside(root, base)) : null;
      const places = from ? [{ root, relative: posix.join(from, clean) }] : [];
      return [...places, { root, relative: clean }];
    });
  };

  /** Open in for a file a reference names: its project-relative path, in a scope; never a root from the request. */
  const fileRoute = async (req: Request): Promise<Response> => {
    if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) return json(crossOriginRefusalBody(), 403);
      const params = url.searchParams;
      const scope = { thread: params.get("thread"), message: params.get("message"), shape: params.get("shape"), repo: params.get("repo"), from: params.get("from") };
      const file = await checkInboxProjectFile(placesOf(scope, params.get("path") ?? ""));
      return json(file.ok ? { found: true, path: file.path, kind: file.kind } : { found: false });
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.path !== "string" || body.path === "") throw new InboxError("validation_error", "path: a path in the project.", { field: "path" });
    if (typeof body.app_id !== "string" || body.app_id === "") throw new InboxError("validation_error", "app_id: an app id.", { field: "app_id" });
    const file = await checkInboxProjectFile(placesOf(body, body.path));
    if (!file.ok) {
      if (file.code === "refused") throw new InboxError("open_not_allowed", `${body.path} is not a file of this project.`);
      throw new InboxError("attachment_missing", `${body.path} is not on this computer.`);
    }
    const line = typeof body.line === "number" && Number.isSafeInteger(body.line) && body.line > 0 ? body.line : undefined;
    return launch(body.app_id, { name: body.path, kind: file.kind, path: file.path }, line);
  };

  /**
   * The text of a file a reference names. A PR's version comes first where the scope has a PR: what the message or the
   * review talks about is that commit, and a checkout here may be on another branch. The path the agent wrote may start
   * in its folder, so each place's path is tried, under the same path rule as a file here.
   */
  const codeRoute = async (req: Request): Promise<Response> => {
    if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const url = new URL(req.url);
    if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) return json(crossOriginRefusalBody(), 403);
    const params = url.searchParams;
    const scope: FileScope = { thread: params.get("thread"), message: params.get("message"), shape: params.get("shape"), repo: params.get("repo"), pull: params.get("pull"), from: params.get("from") };
    const named = params.get("path") ?? "";
    const places = placesOf(scope, named);
    const pulls = typeof scope.pull === "string" ? [scope.pull] : typeof scope.thread === "string" ? threadPulls(scope.thread) : [];
    if (pulls.length > 0) {
      const clean = posix.normalize(named.replace(/\\/g, "/"));
      const paths = [...new Set([...places.map((place) => place.relative), clean])].filter((path) => isShapeProjectPath(path) && !inboxAttachmentNameRefusal(path) && !holdsCredentials(path));
      for (const pull of pulls) {
        for (const path of paths) {
          const file = await pullFile(pull, path);
          if (file) return json({ found: true, contents: file.contents, pull: { label: file.label, platform: file.platform, url: file.url } });
        }
      }
    }
    const file = await checkInboxProjectFile(places);
    if (!file.ok || !isInboxTextKind(file.kind) || holdsCredentials(file.path) || isPlannotatorState(file.path, dataDirs)) return json({ found: false });
    const read = await readFileCapped(file.path);
    return json(read.ok && !read.content.includes("\0") ? { found: true, contents: read.content } : { found: false });
  };

  const scopeOf = (params: URLSearchParams | Record<string, unknown>): FileScope =>
    params instanceof URLSearchParams ? { thread: params.get("thread"), message: params.get("message") } : { thread: params.thread, message: params.message };

  /**
   * Where a path a message names may be, as absolute paths to try in order (approval "inbox-file-refs-open-viewer": no
   * project boundary). `~/…` is in the home folder; an absolute path is itself; a relative one starts where the hover's
   * starts (the agent's folder, its checkout, the thread's projects: `placesOf`), and may lead anywhere from there. A
   * message of another thread brings no folder.
   */
  const candidatesOf = (scope: FileScope, named: string): string[] => {
    if (typeof named !== "string" || named === "" || named.length > 4096) return [];
    if (/^~(?:[\\/]|$)/.test(named)) return [join(givenHome, named.slice(2))];
    if (isAbsolute(named)) return [named];
    return [...new Set(placesOf(scope, named).map((place) => join(place.root, place.relative)))];
  };

  /** The message's own attachment of that file (by its real path), when it carries one. */
  const attachedTo = (scope: FileScope, real: string): string | null => {
    const message = typeof scope.message === "string" ? store.message(scope.message) : null;
    if (!message || message.thread_id !== scope.thread) return null;
    return (message.attachments ?? []).find((file) => file.path === real)?.id ?? null;
  };

  /** The PR's version of a relative path a thread's message names, where the thread owns a PR (what the message talks about is that commit). */
  const pullVersion = async (scope: FileScope, named: string) => {
    if (typeof scope.thread !== "string" || named === "" || isAbsolute(named) || named.startsWith("~")) return null;
    const pulls = threadPulls(scope.thread);
    if (pulls.length === 0) return null;
    const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^\.\//, "");
    const paths = [...new Set([...placesOf(scope, named).map((place) => place.relative), clean])].filter((path) => isShapeProjectPath(path) && !inboxAttachmentNameRefusal(path) && !holdsCredentials(path));
    for (const pull of pulls) {
      for (const path of paths) {
        const file = await pullFile(pull, path);
        if (file) return file;
      }
    }
    return null;
  };

  /** The text of the file on this computer a message names, under the view's refusals and cap; null when there is none. */
  const localText = async (scope: FileScope, named: string): Promise<string | null> => {
    const file = await checkInboxReadableFile(candidatesOf(scope, named), refusedHere, { keep: true });
    if (!file.ok) return null;
    try {
      if (!isInboxTextKind(file.kind)) return null;
      const read = await readTextFrom(file.handle!, file.size, INBOX_VIEW_MAX_BYTES);
      return read.ok ? read.content : null;
    } finally {
      await file.handle!.close().catch(() => {});
    }
  };

  /**
   * A referenced file for the pane. A PR's text first where the thread owns one and the path is relative (what the
   * message talks about is that commit); else the file on this computer, wherever it is, never a secret
   * (`checkInboxReadableFile` with `secretOrSystem`). Text comes back whole, under the view cap; an image or a film is
   * read by the raw route, which checks it all again; any other kind by name only.
   */
  const viewRoute = async (req: Request): Promise<Response> => {
    if (req.method !== "GET") return json({ error: "Use GET." }, 405);
    const url = new URL(req.url);
    if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) return json(crossOriginRefusalBody(), 403);
    const params = url.searchParams;
    const scope = scopeOf(params);
    const named = params.get("path") ?? "";
    const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^\.\//, "");
    const name = clean.split("/").pop() || clean;
    const pulled = await pullVersion(scope, named);
    if (pulled) {
      // A comment attaches the file on this computer, so it is taken only where that file is the version shown.
      const here = await localText(scope, named);
      const local_matches = here !== null && here === pulled.contents;
      return json({ found: true, name, path: clean, kind: kindOfName(name), contents: pulled.contents, local_matches, pull: { label: pulled.label, platform: pulled.platform, url: pulled.url } });
    }
    const file = await checkInboxReadableFile(candidatesOf(scope, named), refusedHere, { keep: true });
    if (!file.ok) return json({ found: false, name, path: clean, reason: file.code });
    const handle = file.handle!;
    try {
      const attached = attachedTo(scope, file.path);
      const found = { found: true, name, path: clean, ...(attached ? { attachment_id: attached } : {}) };
      if (isInboxTextKind(file.kind)) {
        // Read from the handle that was checked: never the path again.
        const read = await readTextFrom(handle, file.size, INBOX_VIEW_MAX_BYTES);
        if (!read.ok) return json({ ...found, kind: "file", tooLarge: true });
        if (read.content.includes("\0")) return json({ ...found, kind: "file" });
        return json({ ...found, kind: file.kind, contents: read.content });
      }
      // A text file past the view cap is a `file` by its kind decision: too large, rather than a kind that never shows.
      const tooLarge = file.kind === "file" && file.size > INBOX_VIEW_MAX_BYTES && inboxAttachmentKind(name) !== "file";
      return json({ ...found, kind: file.kind, ...(tooLarge ? { tooLarge: true } : {}) });
    } finally {
      await handle.close().catch(() => {});
    }
  };

  /**
   * An image's or a film's bytes, for the pane: the same candidates and refusals as the view, at most the upload cap,
   * and the type its first bytes say (an image by its signature, an SVG by its root, a film by its container); anything
   * else is refused. Sandboxed (an SVG never runs), never sniffed, same-origin only, never cached; a film seeks by Range.
   */
  const rawRoute = async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
    const url = new URL(req.url);
    if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) return json(crossOriginRefusalBody(), 403);
    const params = url.searchParams;
    const file = await checkInboxReadableFile(candidatesOf(scopeOf(params), params.get("path") ?? ""), refusedHere, { keep: true });
    if (!file.ok) return json({ found: false }, 404);
    // The handle that was checked serves the bytes: never the path again.
    const handle = file.handle!;
    let handed = false;
    try {
      if (file.kind !== "image" && file.kind !== "video") return json({ found: false }, 404);
      if (file.size > INBOX_UPLOAD_MAX_BYTES) return json({ found: false, code: "too_large" }, 413);
      const stat = await handle.stat();
      const head = new Uint8Array(4096);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const bytes = head.subarray(0, bytesRead);
      const type = file.kind === "image" ? sniffImageContentType(bytes) : sniffInboxVideo(bytes);
      if (!type) return json({ found: false }, 415);
      const etag = inboxStatEtag(stat);
      const headers = {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": INBOX_MESSAGE_IMAGE_CSP,
        "Cross-Origin-Resource-Policy": "same-origin",
        ETag: etag,
      };
      const decision = decideByteRange(req.headers.get("range"), stat.size, { ifRange: req.headers.get("if-range"), etag });
      handed = true;
      return await byteRangeResponse(handle, stat.size, decision, headers, { head: req.method === "HEAD" });
    } finally {
      if (!handed) await handle.close().catch(() => {});
    }
  };

  /**
   * The person commented on a file an agent's message names: it becomes one of that message's attachments, recorded
   * as an agent's attachment is (`recordInboxAttachments`: its realpath, a regular file, never the dotenv family, the
   * bytes kept as the sent version), after the view's refusals. Only a kind the window takes comments on, at most the
   * upload cap. A file the message already carries answers that attachment; nothing is written twice.
   */
  const attachRoute = async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const scope = scopeOf(body);
    if (typeof scope.thread !== "string" || typeof scope.message !== "string") throw new InboxError("validation_error", "thread and message: the message that names the file.", { field: "message" });
    const message = store.message(scope.message);
    if (!message || message.thread_id !== scope.thread) throw new InboxError("message_not_found", `No message ${scope.message} in that thread.`);
    if (typeof body.path !== "string" || body.path === "") throw new InboxError("validation_error", "path: the file the message names.", { field: "path" });
    // Refused before any bytes are copied, so a refusal leaves no blob behind.
    if (message.author.kind !== "agent") throw new InboxError("validation_error", "message_id: only an agent's message takes a file it names.", { field: "message_id" });
    if (!store.messageAnswerable(message.id)) throw new InboxError("thread_resolved", "This thread is resolved; reopen it to annotate.");
    const file = await checkInboxReadableFile(candidatesOf(scope, body.path), refusedHere);
    if (!file.ok) throw new InboxError("attachment_missing", `${body.path} is not on this computer.`);
    // The pane showed the PR's version: a comment on it attaches this computer's file only when that is the same text.
    const pulled = await pullVersion(scope, body.path);
    if (pulled && (await localText(scope, body.path)) !== pulled.contents) {
      throw new InboxError("annotation_not_allowed", `${body.path} on this computer is not the pull request's version.`, { field: "path" });
    }
    const held = attachedTo(scope, file.path);
    if (!held) {
      if (!isInboxAnnotatableKind(file.kind)) throw new InboxError("annotation_not_allowed", `${body.path} takes no comments here.`, { field: "path" });
      if (file.size > INBOX_UPLOAD_MAX_BYTES) throw new InboxError("validation_error", `${body.path} is too large to attach.`, { field: "path" });
    }
    const [recorded] = held ? [null] : await recordInboxAttachments(store.dir, [file.path], { base: dirname(file.path), at: new Date().toISOString() });
    const attachment = recorded ? store.attachReferencedFile(message.id, recorded) : (store.message(message.id)?.attachments ?? []).find((a) => a.id === held)!;
    return json({ attachment: await inboxAttachmentState(attachment, message.id) });
  };

  /** Launch what the per-kind policy allows and this computer has: the app first, nothing is opened for a refusal. */
  const launch = async (appId: string, target: { name: string; kind: unknown; path: string }, line?: number, check?: () => Promise<void>): Promise<Response> => {
    const policy = inboxOpenInPolicy(target, launcher.platform);
    const app = appId === INBOX_OPEN_IN_DEFAULT_APP ? null : getOpenInApp(appId);
    if (appId !== INBOX_OPEN_IN_DEFAULT_APP && !app) throw new InboxError("open_not_allowed", `${appId} is not an app the Inbox opens files in.`);
    if (!inboxOpenInAllows(policy, { id: appId, kind: app?.kind })) {
      throw new InboxError("open_not_allowed", `${target.name} does not open in ${app?.label ?? "its default app"}.`);
    }
    if (app && app.kind === "editor" && !inboxApps(launcher).some((available) => available.id === app.id)) {
      throw new InboxError("app_not_available", `${app.label} is not installed on this computer.`);
    }
    await check?.();
    const result = !app
      ? await launcher.openWithSystemDefault(target.path)
      : app.kind === "file-manager"
        ? await launcher.reveal(target.path)
        : await launcher.openWithApp(app, target.path, line);
    // A failed launch is a valid request with the reason in the body, as /api/open-in answers.
    return json(result);
  };

  return async function handle(req: Request, path: string, via: "local" | "tailnet"): Promise<Response | null> {
    if (path === INBOX_OPEN_IN_CODE_PATH) return ownerOrLocal(req, via) ? codeRoute(req) : localOnly();
    // A file a message names: read only, and attached when commented on. This computer, or its owner through the tailnet.
    if (path === INBOX_OPEN_IN_VIEW_PATH) return ownerOrLocal(req, via) ? viewRoute(req) : localOnly();
    if (path === INBOX_OPEN_IN_RAW_PATH) return ownerOrLocal(req, via) ? rawRoute(req) : localOnly();
    if (path === INBOX_OPEN_IN_ATTACH_PATH) return ownerOrLocal(req, via) ? attachRoute(req) : localOnly();
    if (path !== INBOX_OPEN_IN_PATH && path !== INBOX_OPEN_IN_APPS_PATH && path !== INBOX_OPEN_IN_FILE_PATH) return null;
    // Launching an app changes this computer: never through the tailnet.
    if (via === "tailnet") return localOnly();

    if (path === INBOX_OPEN_IN_FILE_PATH) return fileRoute(req);

    if (path === INBOX_OPEN_IN_APPS_PATH) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      return json({ available: true, platform: launcher.platform, apps: inboxApps(launcher) });
    }

    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    const attachmentId = body.attachment_id;
    if (typeof attachmentId !== "string" || !/^att_[A-Za-z0-9]+$/.test(attachmentId)) {
      throw new InboxError("validation_error", "attachment_id: an attachment id.", { field: "attachment_id" });
    }
    const appId = body.app_id;
    if (typeof appId !== "string" || appId === "") throw new InboxError("validation_error", "app_id: an app id.", { field: "app_id" });

    const hit = store.attachment(attachmentId);
    if (!hit) throw new InboxError("attachment_not_found", `No attachment ${attachmentId}.`);
    const { attachment } = hit;

    // The record's realpath, checked just now: never a path from the request.
    return launch(appId, attachment, undefined, async () => {
      const check = await checkInboxAttachmentForLaunch(store.dir, attachment);
      if (!check.ok) throw new InboxError(check.unavailable.code, check.unavailable.message);
    });
  };
}
