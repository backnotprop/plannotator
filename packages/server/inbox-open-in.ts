/**
 * Plannotator Inbox: "Open in" for attachments (design record
 * "inbox-open-in", approved 2026-10-14). Two routes, both on this computer
 * only (`403 local_only` through the tailnet, and never on the phone's
 * device door, whose allowlist does not name them):
 *
 *   GET  /api/inbox/open-in/apps  the editors and the file manager this host has
 *   POST /api/inbox/open-in       { attachment_id, app_id, serverSession }
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
 * The launcher is a seam (`InboxOpenInLauncher`): tests pass a recording one
 * and never start a real app.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_OPEN_IN_DEFAULT_APP, inboxOpenInAllows, inboxOpenInPolicy } from "@plannotator/core/inbox-types";
import { getOpenInApp, type OpenInApp, type OpenInPlatform } from "@plannotator/core/open-in-apps";
import { checkInboxAttachmentForLaunch } from "@plannotator/shared/inbox/attachments";
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

/** How the Inbox launches: the host's real launcher, or a test's stub. */
export interface InboxOpenInLauncher {
  platform: OpenInPlatform;
  /** The catalog apps installed here (always the file manager). */
  apps: () => AvailableOpenInApp[];
  reveal: (path: string) => Promise<OpenInLaunchResult>;
  openWithApp: (app: OpenInApp, path: string) => Promise<OpenInLaunchResult>;
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
}

export function createInboxOpenInRoute(context: InboxOpenInRouteContext) {
  const { store, serverSession, readBody, json, localOnly, launcher } = context;

  return async function handle(req: Request, path: string, via: "local" | "tailnet"): Promise<Response | null> {
    if (path !== INBOX_OPEN_IN_PATH && path !== INBOX_OPEN_IN_APPS_PATH) return null;
    // Launching an app changes this computer: never through the tailnet.
    if (via === "tailnet") return localOnly();

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
    const policy = inboxOpenInPolicy(attachment, launcher.platform);

    // The app first (nothing is read for a refusal), then the file.
    const app = appId === INBOX_OPEN_IN_DEFAULT_APP ? null : getOpenInApp(appId);
    if (appId !== INBOX_OPEN_IN_DEFAULT_APP && !app) throw new InboxError("open_not_allowed", `${appId} is not an app the Inbox opens files in.`);
    if (!inboxOpenInAllows(policy, { id: appId, kind: app?.kind })) {
      throw new InboxError("open_not_allowed", `${attachment.name} does not open in ${app?.label ?? "its default app"}.`);
    }
    if (app && app.kind === "editor" && !inboxApps(launcher).some((available) => available.id === app.id)) {
      throw new InboxError("app_not_available", `${app.label} is not installed on this computer.`);
    }

    const check = await checkInboxAttachmentForLaunch(store.dir, attachment);
    if (!check.ok) throw new InboxError(check.unavailable.code, check.unavailable.message);

    // The record's realpath, checked just now: never a path from the request.
    const result = !app
      ? await launcher.openWithSystemDefault(attachment.path)
      : app.kind === "file-manager"
        ? await launcher.reveal(attachment.path)
        : await launcher.openWithApp(app, attachment.path);
    // A failed launch is a valid request with the reason in the body, as /api/open-in answers.
    return json(result);
  };
}
