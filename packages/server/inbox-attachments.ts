/**
 * Plannotator Inbox: the routes for attachments, annotations and deleting
 * (step 2 of the Inbox plan), mounted at the end of the Inbox server's route
 * table (packages/server/inbox.ts) behind its Host, Origin and same-origin
 * guards.
 *
 * A file is reached ONLY by its attachment id: there is no route that takes a
 * path. The current file is read through its record with the rules in
 * packages/shared/inbox/attachments.ts; `?version=sent` reads the blob of
 * the bytes the agent sent. Raw bytes always go out as `text/plain` with a
 * `sandbox` CSP and nosniff, so an attached HTML page never runs on the
 * Inbox's origin. HTML is drawn through annotate's own serving path: the
 * page with a `<base href>` at `/api/html-assets/<token>/` (one token per
 * folder, packages/server/html-assets.ts), whose answers carry the
 * `sandbox allow-scripts` CSP, inside Plannotator's sandboxed HtmlViewer, so
 * its relative images and frames load from the file's own folder and never
 * draw the Inbox inside itself (#1554).
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_ANNOTATION_CURRENT, type InboxAttachment } from "@plannotator/core/inbox-types";
import {
  inboxAttachmentState,
  readInboxAttachmentCurrent,
  readInboxAttachmentSent,
} from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createHtmlAssetRegistry } from "./html-assets";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface InboxAttachmentRoutesContext {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
}

type Version = "current" | "sent";

function versionOf(url: URL): Version {
  const value = url.searchParams.get("version");
  if (value === null || value === "" || value === "current") return "current";
  if (value === "sent") return "sent";
  throw new InboxError("validation_error", "version: \"current\" or \"sent\".", { field: "version" });
}

/** The bytes of one version, or the reason the current file cannot be read. */
function readVersion(store: InboxStore, attachment: InboxAttachment, version: Version): Buffer {
  if (version === "sent") {
    const bytes = readInboxAttachmentSent(store.dir, attachment);
    if (!bytes) throw new InboxError("attachment_missing", `The sent version of ${attachment.name} is gone.`);
    return bytes;
  }
  const current = readInboxAttachmentCurrent(attachment);
  if (!current.ok) throw new InboxError(current.unavailable.code, current.unavailable.message);
  return current.bytes;
}

export function createInboxAttachmentRoutes(context: InboxAttachmentRoutesContext) {
  const { store, serverSession } = context;
  const htmlAssets = createHtmlAssetRegistry();

  const guardedBody = async (req: Request): Promise<Record<string, unknown> | Response> => {
    const body = await context.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    return body;
  };

  const attachmentOf = (id: string) => {
    const hit = store.attachment(id);
    if (!hit) throw new InboxError("attachment_not_found", `No attachment ${id}.`);
    return hit;
  };

  /** Answers a request on one of these routes, or null when the path is not one of them. */
  return async function handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;

    const assets = await htmlAssets.handle(req, url);
    if (assets) return assets;

    const threadAttachments = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/attachments$/.exec(path);
    if (threadAttachments) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const threadId = threadAttachments[1]!;
      if (!store.thread(threadId)) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      return json({
        serverSession,
        attachments: store.threadAttachments(threadId).map(({ attachment, message }) => inboxAttachmentState(attachment, message.id)),
        annotations: store.pendingAnnotations(threadId),
      });
    }

    const view = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/view$/.exec(path);
    if (view) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      const { attachment, message } = attachmentOf(view[1]!);
      const version = versionOf(url);
      const text = readVersion(store, attachment, version).toString("utf8");
      return json({
        serverSession,
        attachment: inboxAttachmentState(attachment, message.id),
        version: version === "sent" ? attachment.sent_sha256 : INBOX_ANNOTATION_CURRENT,
        text,
        // The page as annotate serves it: a <base href> at its own folder's asset route.
        html: attachment.kind === "html" ? htmlAssets.rewriteHtml(text, attachment.path) : null,
      });
    }

    const raw = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)$/.exec(path);
    if (raw) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      const { attachment } = attachmentOf(raw[1]!);
      const bytes = readVersion(store, attachment, versionOf(url));
      return new Response(req.method === "HEAD" ? null : new Uint8Array(bytes), {
        headers: {
          // Always text: an attached page is never rendered on this origin.
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": "sandbox",
          "Content-Disposition": `inline; filename="${attachment.name.replace(/["\\\r\n]/g, "_")}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (path === "/api/inbox/annotations") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      const record = store.saveAnnotation({
        attachment_id: typeof body.attachment_id === "string" ? body.attachment_id : "",
        version: body.version,
        annotation: body.annotation,
      });
      return json({ annotation: record });
    }

    const remove = /^\/api\/inbox\/annotations\/([A-Za-z0-9_.:-]+)\/remove$/.exec(path);
    if (remove) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      return json({ annotation: store.removeAnnotation(remove[1]!) });
    }

    const deleteThread = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/delete$/.exec(path);
    if (deleteThread) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      store.deleteThread(deleteThread[1]!);
      return json({ ok: true, store: store.diskUsage() });
    }

    const deleteProject = /^\/api\/inbox\/projects\/(prj_[A-Za-z0-9]+)\/delete$/.exec(path);
    if (deleteProject) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      store.deleteProject(deleteProject[1]!);
      return json({ ok: true, store: store.diskUsage() });
    }

    return null;
  };
}
