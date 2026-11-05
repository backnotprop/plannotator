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
 * first), `shape`, or `repo` (a PR page: `host/owner/repo`, every clone here).
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
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { checkInboxAttachmentForLaunch, checkInboxProjectFile, type InboxProjectFilePlace } from "@plannotator/shared/inbox/attachments";
import { crossOriginRefusalBody, isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { InboxError } from "@plannotator/shared/inbox/schema";
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

export const INBOX_OPEN_IN_PATH = "/api/inbox/open-in";
export const INBOX_OPEN_IN_APPS_PATH = "/api/inbox/open-in/apps";
export const INBOX_OPEN_IN_FILE_PATH = "/api/inbox/open-in/file";

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
}

/** The scope of a referenced file: where its path starts. */
/** The checkout a folder lies in: the nearest folder up with a `.git` (a file in a linked worktree). */
function checkoutOf(folder: string): string | null {
  if (!existsSync(folder)) return null;
  for (let dir = folder; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
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
}

export function createInboxOpenInRoute(context: InboxOpenInRouteContext) {
  const { store, serverSession, readBody, json, localOnly, launcher, codeReviewOn, shapeRoot, repoRoots } = context;

  /**
   * Where a scope's path may be, in the order to try. A shape's or a repository's path starts at its root. A message's
   * link is as the agent wrote it, so it starts in the checkout the agent wrote from: at its folder (`base_path`), then
   * at that checkout's top. Other projects come after, except that a linked worktree folded into its project never falls
   * back to the main checkout: that copy is not the agent's file. An absolute path says which of these it means.
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
    const checkout = base ? checkoutOf(base) : null;
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
    const folded = checkout !== null && own !== null && pathInside(own, checkout) === null && pathInside(checkout, own) === null && checkout !== own;
    const roots = known(folded ? [checkout, ...shown.filter((root) => root !== own)] : [checkout, own, ...shown]);
    const clean = posix.normalize(named.replace(/\\/g, "/"));
    return roots.flatMap((root) => {
      const from = base ? (base === root ? "" : pathInside(root, base)) : null;
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
      const scope = { thread: params.get("thread"), message: params.get("message"), shape: params.get("shape"), repo: params.get("repo") };
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
