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
 * The code route and the file route's GET only read, so they also answer the owner through the tailnet (a phone's
 * tap, a window's Copy path); a linked machine's window reads both through the door, held to its thread. A thread that owns a pull
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
 * A referenced file (a review's diff headers; while Code
 * review is on) is not a record, so its route takes a project-relative path and
 * a scope, never a root: `thread` (with `message`, the message's own project
 * first; with `from: "root"` for a diff's path), or `repo` (a PR page: `host/owner/repo`, every clone here).
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
  readInboxAttachmentText,
  recordInboxAttachments,
  type InboxProjectFilePlace,
  type InboxReadableFile,
} from "@plannotator/shared/inbox/attachments";
import { INBOX_MACHINE_FILE_WINDOW_ONLY_BODY } from "./inbox-machines";
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
import { isLinkedWorktree } from "@plannotator/shared/linked-worktree";
import { checkoutOf, holdsCredentials, inboxMessageCandidates, inboxMessagePlaces, inboxPullPaths, pathInside, realpathOrNull, type FileScope } from "./inbox-message-places";
import { earlierFolderPaths, linkFallbacks, sameNamedAttachment, type LinkFallback } from "./inbox-link-fallback";
import { fileNotFoundSentence } from "@plannotator/core/inbox-types";
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
  /** The folders of every project on a repository (`host/owner/repo`, lowercased). */
  repoRoots: (repo: string) => string[];
  /** The pull requests a thread owns, the latest hand-over first. */
  threadPulls: (thread: string) => string[];
  /** A file at a pull request's head commit, or null. */
  pullFile: (pull: string, path: string) => Promise<InboxPullFile | null>;
  /** The person's home folder, by default this process's. */
  home?: string;
  /** Who the device door handed this request in for: a linked machine (`window`: a press in a window there); else null. */
  doorOf?: (req: Request) => { window: boolean } | null;
}

// The places a message's path may be, and the credential rule: inbox-message-places.ts (the send's link check reads them
// without this module's imports).
export { checkoutOf, inboxMessageCandidates, inboxMessagePlaces, inboxPullPaths, type FileScope } from "./inbox-message-places";
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

/** The PRs a thread owns and a file's text at a PR, as the route reads them (the send's `links_not_found` reads only what is kept). */
export type InboxLinkPulls = Pick<InboxOpenInRouteContext, "threadPulls" | "pullFile">;

/** A readable file held to a window's reach: `away`, a file that is there but whose realpath leads out of that reach. */
type Reached = InboxReadableFile | { ok: false; code: "missing"; away: true };


/**
 * The PR's version of a relative path a thread's message names, where the thread owns a PR (what the message talks
 * about is that commit): the referenced file view's first look.
 */
export async function inboxPullVersion(store: InboxStore, home: string, pulls: InboxLinkPulls, scope: FileScope, named: string): Promise<InboxPullFile | null> {
  const keys = typeof scope.thread === "string" ? pulls.threadPulls(scope.thread) : [];
  if (keys.length === 0) return null;
  const paths = inboxPullPaths(store, home, scope, named);
  for (const pull of keys) {
    for (const path of paths) {
      const file = await pulls.pullFile(pull, path);
      if (file) return file;
    }
  }
  return null;
}

export function createInboxOpenInRoute(context: InboxOpenInRouteContext) {
  const { store, serverSession, readBody, json, localOnly, launcher, codeReviewOn, repoRoots, threadPulls, pullFile } = context;
  const givenHome = context.home ?? homedir();
  const home = realpathOrNull(givenHome) ?? givenHome;
  // The home folder as given and at its realpath (`/home` -> `/var/home`), so either spelling of `~/.plannotator` is
  // refused, also when that folder is made after the Inbox starts.
  // The data folder is the store's parent (`<data>/inbox`); a route made without a store folder (a refusal-only use)
  // still guards the home's.
  const storeData = typeof store.dir === "string" && store.dir !== "" ? [dirname(store.dir)] : [];
  const dataDirs = [...new Set([...storeData, join(givenHome, ".plannotator"), join(home, ".plannotator")].flatMap((dir) => [dir, realpathOrNull(dir) ?? dir]))];
  /** What a referenced file's view, raw read and attach refuse: a secret, a live system file, Plannotator's own state. */
  const refusedHere = (path: string): boolean => secretOrSystem(path) || isPlannotatorState(path, dataDirs);

  const placesOf = (scope: FileScope, named: string): InboxProjectFilePlace[] =>
    typeof scope.repo === "string" ? repoRoots(scope.repo.toLowerCase()).map((root) => ({ root, relative: named })) : inboxMessagePlaces(store, home, scope, named);

  /**
   * A read's scope from its query. A linked machine's window (through the door) asks about its thread only: that
   * thread's folders and PRs, never every clone of a repository (`repo`) or a PR it names (`pull`), so its window
   * cannot read the rest of this computer through a hover or a Copy path.
   */
  const scopeFor = (req: Request, params: URLSearchParams): { scope: FileScope; door: boolean } => {
    const door = !!context.doorOf?.(req);
    const own = { thread: params.get("thread"), message: params.get("message"), from: params.get("from") };
    return { door, scope: door ? own : { ...own, repo: params.get("repo"), pull: params.get("pull") } };
  };

  /** Open in for a file a reference names: its project-relative path, in a scope; never a root from the request. */
  const fileRoute = async (req: Request): Promise<Response> => {
    if (!codeReviewOn()) return json({ error: "Code review is off.", code: "code_review_off" }, 409);
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) return json(crossOriginRefusalBody(), 403);
      if (notFromWindow(req)) return json(INBOX_MACHINE_FILE_WINDOW_ONLY_BODY, 403);
      const { scope, door } = scopeFor(req, url.searchParams);
      const file = await projectFileOf(scope, url.searchParams.get("path") ?? "");
      // A linked machine's window is never told a secret is there, as its hover never shows one.
      if (file.ok && door && (holdsCredentials(file.path) || isPlannotatorState(file.path, dataDirs))) return json({ found: false });
      return json(file.ok ? { found: true, path: file.path, kind: file.kind } : { found: false });
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.path !== "string" || body.path === "") throw new InboxError("validation_error", "path: a path in the project.", { field: "path" });
    if (typeof body.app_id !== "string" || body.app_id === "") throw new InboxError("validation_error", "app_id: an app id.", { field: "app_id" });
    const file = await projectFileOf(body, body.path);
    if (!file.ok) {
      if (file.code === "refused") throw new InboxError("open_not_allowed", `${body.path} is not a file of this project.`);
      throw new InboxError("attachment_missing", notFoundSentence(req, body, body.path));
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
    if (notFromWindow(req)) return json(INBOX_MACHINE_FILE_WINDOW_ONLY_BODY, 403);
    const { scope } = scopeFor(req, url.searchParams);
    const named = url.searchParams.get("path") ?? "";
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
    const file = await projectFileOf(scope, named);
    if (!file.ok) {
      const held = await heldText(req, scope, named);
      return json(held !== null ? { found: true, contents: held } : { found: false });
    }
    if (!isInboxTextKind(file.kind) || holdsCredentials(file.path) || isPlannotatorState(file.path, dataDirs)) return json({ found: false });
    const read = await readFileCapped(file.path);
    return json(read.ok && !read.content.includes("\0") ? { found: true, contents: read.content } : { found: false });
  };

  const scopeOf = (params: URLSearchParams | Record<string, unknown>): FileScope =>
    params instanceof URLSearchParams ? { thread: params.get("thread"), message: params.get("message") } : { thread: params.thread, message: params.message };

  const candidatesOf = (scope: FileScope, named: string): string[] => inboxMessageCandidates(store, givenHome, home, scope, named);

  /**
   * Whether the message names this path as the window sends it (as written; a link's own spelling, encoded or with
   * backslashes): a whole word of its body, so `c/retry.ts` is not named by `src/retry.ts`.
   */
  const namedBy = (scope: FileScope, named: string): boolean => {
    const message = typeof scope.message === "string" ? store.message(scope.message) : null;
    // Only an agent's message draws file links; the person's words (a reply a linked machine may post) name nothing.
    if (!message || message.thread_id !== scope.thread || message.author.kind !== "agent" || typeof named !== "string" || named === "") return false;
    const body = message.body ?? "";
    for (const form of new Set([named, encodeURI(named), named.replace(/\//g, "\\")])) {
      for (let at = body.indexOf(form); at !== -1; at = body.indexOf(form, at + 1)) {
        const before = at === 0 ? "" : body[at - 1]!;
        const after = body[at + form.length] ?? "";
        if (/^$|[\s(\[<`"']/.test(before) && /^$|[\s)\]>`"':#?,.;!]/.test(after)) return true;
      }
    }
    return false;
  };

  /**
   * How far a request reaches. This computer's window: any file but a secret (null). A linked machine's, through the
   * device door: a path the message names, else only a file in the thread's folders (at their realpaths too), so its
   * agent cannot read the rest of this computer through a thread.
   */
  const reachOf = (req: Request, scope: FileScope, named: string): string[] | null => {
    if (!context.doorOf?.(req) || namedBy(scope, named)) return null;
    return threadFolders(scope);
  };
  /** The thread's folders, as given and at their realpaths: a linked machine's reach for a path its message does not name. */
  const threadFolders = (scope: FileScope): string[] => {
    const roots = placesOf({ thread: scope.thread, message: scope.message }, "x").map((place) => place.root);
    return [...new Set(roots.flatMap((root) => [root, realpathOrNull(root) ?? root]))];
  };
  const within = (roots: string[] | null, path: string): boolean => roots === null || roots.some((root) => pathInside(root, path) !== null);

  /**
   * `checkInboxReadableFile` held to a reach: a candidate outside it, or one whose realpath leads out, is not here. The
   * latter is there, only out of reach (`away`): missing to that window, and said with no place, as it is at that path.
   */
  const readableWithin = async (roots: string[] | null, scope: FileScope, named: string, keep: boolean, candidates = candidatesOf(scope, named)): Promise<Reached> => {
    const file = await checkInboxReadableFile(candidates.filter((path) => within(roots, path)), refusedHere, { keep });
    if (!file.ok || within(roots, file.path)) return file;
    await file.handle?.close().catch(() => {});
    return { ok: false, code: "missing", away: true };
  };
  const away = (file: Reached): boolean => !file.ok && "away" in file;

  /**
   * Where a missing file was looked for first (the message's own folder), as the window names a file of the thread:
   * from the thread's project folder when it lies there, else as it is on this computer. A linked machine's window
   * (through the door) is handed only a path in the thread's project, never one elsewhere on this computer it could
   * not see before (`~/x` is this computer's home): null, and the words then name no path.
   */
  const lookedIn = (req: Request, scope: FileScope, named: string): string | null => {
    const place = typeof scope.repo === "string" ? placesOf(scope, named)[0] : null;
    if (place) return place.relative;
    const first = candidatesOf(scope, named)[0];
    if (!first) return null;
    const project = typeof scope.thread === "string" ? store.thread(scope.thread)?.project.root : null;
    const inProject = project ? pathInside(project, first) : null;
    return context.doorOf?.(req) ? inProject : (inProject ?? first);
  };

  /** What a route says of a file found nowhere (inbox-file-missing-words.ts, the pane's own words); `outOfReach`: with no place. */
  const notFoundSentence = (req: Request, scope: FileScope, named: string, outOfReach = false): string => {
    const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^\.\//, "");
    return fileNotFoundSentence(clean.split("/").pop() || clean, outOfReach ? null : lookedIn(req, scope, named));
  };

  /** A linked machine's request that is not a press in a window there: refused, as its own Inbox refuses it. */
  const notFromWindow = (req: Request): boolean => {
    const door = context.doorOf?.(req);
    return !!door && !door.window;
  };

  /** The message's own attachment of that file (by its real path), when it carries one. */
  const attachedTo = (scope: FileScope, real: string): string | null => {
    const message = typeof scope.message === "string" ? store.message(scope.message) : null;
    if (!message || message.thread_id !== scope.thread) return null;
    return (message.attachments ?? []).find((file) => file.path === real)?.id ?? null;
  };

  /** The PR's version of a relative path a thread's message names, where the thread owns a PR (what the message talks about is that commit). */
  const pullVersion = (scope: FileScope, named: string) => inboxPullVersion(store, home, { threadPulls, pullFile }, scope, named);

  /** Where a link may be when the message's own places miss (inbox-link-fallback.ts): every route's one order. */
  const fallbacksOf = (scope: FileScope, named: string): LinkFallback[] => linkFallbacks(store, home, scope, named);

  /**
   * A relative link not at the message's own places, from the folders the same sender's earlier messages in the thread
   * were sent from (inbox-link-fallback.ts: its shell may have moved between them). A linked machine's request holds
   * them to the thread's folders even for a path its message names: they are not what the message names.
   */
  const fromEarlierFolders = async (req: Request, roots: string[] | null, scope: FileScope, named: string, keep: boolean, fallbacks = fallbacksOf(scope, named)): Promise<Reached | null> => {
    const earlier = earlierFolderPaths(fallbacks);
    if (earlier.length === 0) return null;
    const there = await readableWithin(roots ?? (context.doorOf?.(req) ? threadFolders(scope) : null), scope, named, keep, earlier);
    return there.ok || away(there) ? there : null;
  };

  /** The file a message names: at its own places, else (only when nothing is there) from the sender's earlier folders. */
  const locate = async (req: Request, roots: string[] | null, scope: FileScope, named: string, keep: boolean): Promise<Reached> => {
    const file = await readableWithin(roots, scope, named, keep);
    if (file.ok || file.code !== "missing") return file;
    return (await fromEarlierFolders(req, roots, scope, named, keep)) ?? file;
  };

  /**
   * The hover's and Open in's places for a link its message's own places miss: each fallback's path on this computer
   * (an attachment's as it was attached from, then the sender's earlier folders), held to the thread's folders as a
   * place of the project, so the path rule (`checkInboxProjectFile`) and a linked machine's reach stay as they were.
   */
  const fallbackPlacesOf = (scope: FileScope, named: string): InboxProjectFilePlace[] => {
    if (typeof scope.repo === "string") return [];
    const folders = [...new Set(placesOf({ thread: scope.thread, message: scope.message }, "x").map((place) => place.root))];
    return fallbacksOf(scope, named).flatMap(({ path }) =>
      folders.flatMap((root) => {
        const inside = pathInside(root, path);
        return inside ? [{ root, relative: inside }] : [];
      }),
    );
  };

  /**
   * `checkInboxProjectFile` at a scope's places, then (only after a miss, as `locate`) at its fallbacks, which the same
   * path rule holds. A refused file (a dotenv name, a link out of the project) stays refused, never replaced by another
   * file. A place that only leads out of the project (a `../` link from the project's top) is no file of it: that alone
   * is a miss, and the file may still be in a folder the sender wrote from before.
   */
  const projectFileOf = async (scope: FileScope, named: string) => {
    const places = placesOf(scope, named);
    const file = await checkInboxProjectFile(places);
    if (file.ok) return file;
    if (file.code === "refused") {
      const shaped = await checkInboxProjectFile(places.filter((place) => isShapeProjectPath(place.relative)));
      if (!shaped.ok && shaped.code === "refused") return file;
    }
    const fallback = fallbackPlacesOf(scope, named);
    if (fallback.length === 0) return file;
    const there = await checkInboxProjectFile(fallback);
    return there.ok ? there : file;
  };

  /**
   * The text of the attachment the pane opens for a link its message's own places miss (inbox-link-fallback.ts), so
   * the hover shows a file exactly when the pane would: the file as it is now, else the copy kept when it was sent.
   * Open in has no such path to launch: its check stays the attachment's own path on disk, when that is still there.
   */
  const heldText = async (req: Request, scope: FileScope, named: string): Promise<string | null> => {
    const held = sameNamedAttachment(fallbacksOf(scope, named));
    if (!held) return null;
    const own = await readableWithin(reachOf(req, scope, named), scope, named, false);
    if (own.ok || own.code !== "missing") return null;
    const attachment = store.attachment(held)?.attachment;
    if (!attachment || !isInboxTextKind(attachment.kind) || holdsCredentials(attachment.path)) return null;
    for (const version of ["current", "sent"] as const) {
      const read = await readInboxAttachmentText(store.dir, attachment, version);
      if (read.ok) return read.bytes.includes(0) ? null : read.bytes.toString("utf8");
    }
    return null;
  };

  /** The text of the file on this computer a message names, under the view's refusals and cap; null when there is none. */
  const localText = async (req: Request, roots: string[] | null, scope: FileScope, named: string): Promise<string | null> => {
    const file = await locate(req, roots, scope, named, true);
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
    if (notFromWindow(req)) return json(INBOX_MACHINE_FILE_WINDOW_ONLY_BODY, 403);
    const params = url.searchParams;
    const scope = scopeOf(params);
    const named = params.get("path") ?? "";
    const roots = reachOf(req, scope, named);
    const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^\.\//, "");
    const name = clean.split("/").pop() || clean;
    const pulled = await pullVersion(scope, named);
    if (pulled) {
      // A comment attaches the file on this computer, so it is taken only where that file is the version shown.
      const here = await localText(req, roots, scope, named);
      const local_matches = here !== null && here === pulled.contents;
      return json({ found: true, name, path: clean, kind: kindOfName(name), contents: pulled.contents, local_matches, pull: { label: pulled.label, platform: pulled.platform, url: pulled.url } });
    }
    let file = await readableWithin(roots, scope, named, true);
    if (!file.ok && file.code === "missing") {
      // Not where this message's folder says: the file of that name the thread was handed opens as that attachment,
      // else the link from the folders the same sender wrote from before (inbox-link-fallback.ts).
      const fallbacks = fallbacksOf(scope, named);
      const held = sameNamedAttachment(fallbacks);
      if (held) return json({ found: true, name, path: clean, kind: "file", attachment_id: held });
      file = (await fromEarlierFolders(req, roots, scope, named, true, fallbacks)) ?? file;
    }
    const looked = !file.ok && file.code === "missing" && !away(file) ? lookedIn(req, scope, named) : null;
    if (!file.ok) return json({ found: false, name, path: clean, reason: file.code, ...(looked ? { looked_in: looked } : {}) });
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
    if (notFromWindow(req)) return json(INBOX_MACHINE_FILE_WINDOW_ONLY_BODY, 403);
    const params = url.searchParams;
    const scope = scopeOf(params);
    const named = params.get("path") ?? "";
    const file = await locate(req, reachOf(req, scope, named), scope, named, true);
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
    if (notFromWindow(req)) return json(INBOX_MACHINE_FILE_WINDOW_ONLY_BODY, 403);
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
    const roots = reachOf(req, scope, body.path);
    const file = await locate(req, roots, scope, body.path, false);
    if (!file.ok) throw new InboxError("attachment_missing", file.code === "refused" ? `${body.path} does not show here.` : notFoundSentence(req, scope, body.path, away(file)));
    // The pane showed the PR's version: a comment on it attaches this computer's file only when that is the same text.
    const pulled = await pullVersion(scope, body.path);
    if (pulled && (await localText(req, roots, scope, body.path)) !== pulled.contents) {
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
    if (path === INBOX_OPEN_IN_CODE_PATH) return codeRoute(req);
    // A file a message names: read only, and attached when commented on.
    if (path === INBOX_OPEN_IN_VIEW_PATH) return viewRoute(req);
    if (path === INBOX_OPEN_IN_RAW_PATH) return rawRoute(req);
    if (path === INBOX_OPEN_IN_ATTACH_PATH) return attachRoute(req);
    if (path !== INBOX_OPEN_IN_PATH && path !== INBOX_OPEN_IN_APPS_PATH && path !== INBOX_OPEN_IN_FILE_PATH) return null;
    // Whether a referenced file is here, and its path: only a read, so the owner's window over the tailnet asks it too
    // (its Copy path), and a linked machine's window through the door (held to the thread's folders in `fileRoute`).
    if (path === INBOX_OPEN_IN_FILE_PATH && req.method === "GET") return fileRoute(req);
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
