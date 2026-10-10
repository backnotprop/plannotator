/**
 * Plannotator Inbox: the routes for attachments, annotations and deleting
 * (step 2 of the Inbox plan), mounted at the end of the Inbox server's route
 * table (packages/server/inbox.ts) behind its Host, Origin and same-origin
 * guards.
 *
 * A file is reached ONLY by its attachment id: there is no route that takes a
 * path. The current file is read through its record with the rules in
 * packages/shared/inbox/attachments.ts; `?version=sent` reads the blob of
 * the bytes the agent sent. Raw bytes of a text kind always go out as
 * `text/plain` with a `sandbox` CSP and nosniff, so an attached HTML page
 * never runs on the Inbox's origin. An image goes out from its own route as
 * the type its bytes sniff as (never the name's, never the record's), for
 * `<img src>` only: an SVG drawn by `<img>` runs no script, and opened
 * directly the `sandbox` CSP still stops it. Any kind downloads from
 * `/download` as an attachment (`application/pdf` for a PDF,
 * `application/octet-stream` otherwise), streamed from one descriptor. Every
 * byte answer carries nosniff, a `sandbox` CSP and a same-origin CORP, and a
 * request another site makes is refused before anything is read. The
 * phone's door hands its requests to these same routes
 * (packages/server/inbox-devices.ts), so the checks and headers are one. HTML is drawn through annotate's own serving path: the
 * page with a `<base href>` at `/api/html-assets/<token>/` (one token per
 * folder, packages/server/html-assets.ts), whose answers carry the
 * `sandbox allow-scripts` CSP, inside Plannotator's sandboxed HtmlViewer, so
 * its relative images and frames load from the file's own folder and never
 * draw the Inbox inside itself (#1554).
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { closeSync, read as readFd } from "node:fs";
import { INBOX_ANNOTATION_CURRENT, isInboxTextKind, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import {
  inboxAttachmentState,
  isPdfHead,
  openInboxAttachmentVersion,
  readInboxAttachmentCurrent,
  readInboxAttachmentSent,
} from "@plannotator/shared/inbox/attachments";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { readInboxMarkup, writeInboxMarkup } from "@plannotator/shared/inbox/markups";
import { readImageDimensions, sniffImageContentType } from "@plannotator/shared/review-image";
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

/** Headers every byte answer carries: never sniffed, never run, never read by another site. */
const BYTE_GUARD_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

/** `filename` (an ASCII fallback) and `filename*` (the real name, percent-encoded) for Content-Disposition. */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A descriptor as a response body, read in 1 MiB chunks and closed at its end or when the reader goes away. */
function fdStream(fd: number): ReadableStream<Uint8Array> {
  let position = 0;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      try {
        const n = await new Promise<number>((done, fail) =>
          readFd(fd, buffer, 0, buffer.length, position, (error, bytesRead) => (error ? fail(error) : done(bytesRead))),
        );
        if (n === 0) {
          close();
          controller.close();
          return;
        }
        position += n;
        controller.enqueue(buffer.subarray(0, n));
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel() {
      close();
    },
  });
}

/** A request another site (or another localhost port) made: refused before anything is read. */
function crossSite(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

const CROSS_SITE_BODY = { error: "Cross-origin requests are not accepted.", code: "cross_origin" };

function notText(attachment: InboxAttachment): InboxError {
  return new InboxError("attachment_not_text", `${attachment.name} is not a text file; it opens from its image or download route.`);
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
      if (!isInboxTextKind(attachment.kind)) throw notText(attachment);
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
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(raw[1]!);
      // A binary kind is never streamed as text: it has the image and download routes.
      if (!isInboxTextKind(attachment.kind)) throw notText(attachment);
      const bytes = readVersion(store, attachment, versionOf(url));
      return new Response(req.method === "HEAD" ? null : new Uint8Array(bytes), {
        headers: {
          ...BYTE_GUARD_HEADERS,
          // Always text: an attached page is never rendered on this origin.
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Security-Policy": "sandbox",
          "Content-Disposition": contentDisposition("inline", attachment.name),
          "Cache-Control": "no-store",
        },
      });
    }

    const bytesRoute = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/(image|download)$/.exec(path);
    if (bytesRoute) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(bytesRoute[1]!);
      const route = bytesRoute[2] as "image" | "download";
      const kind = readInboxAttachmentKind(attachment.kind);
      if (route === "image" && kind !== "image") throw new InboxError("attachment_not_image", `${attachment.name} is not an image; download it instead.`);
      const opened = openInboxAttachmentVersion(store.dir, attachment, versionOf(url));
      if (!opened.ok) throw new InboxError(opened.code, opened.message);
      let contentType: string;
      const extra: Record<string, string> = {};
      if (route === "image") {
        // The type of the bytes served, sniffed now: never the record's, never the name's.
        const sniffed = sniffImageContentType(opened.head);
        if (!sniffed) {
          closeSync(opened.fd);
          throw new InboxError("attachment_not_image", `${attachment.name} is no longer an image.`);
        }
        contentType = sniffed;
        const dims = readImageDimensions(opened.head, sniffed);
        if (dims) {
          extra["X-Image-Width"] = String(dims.width);
          extra["X-Image-Height"] = String(dims.height);
        }
      } else {
        contentType = kind === "pdf" && isPdfHead(opened.head) ? "application/pdf" : "application/octet-stream";
      }
      const etag = `"${opened.sha256}"`;
      const headers: Record<string, string> = {
        ...BYTE_GUARD_HEADERS,
        ...extra,
        "Content-Type": contentType,
        "Content-Security-Policy": route === "image" ? INBOX_MESSAGE_IMAGE_CSP : "sandbox",
        "Content-Disposition": contentDisposition(route === "image" ? "inline" : "attachment", attachment.name),
        "Cache-Control": route === "image" ? "private, no-cache" : "no-store",
        ETag: etag,
      };
      if (req.method === "HEAD") {
        closeSync(opened.fd);
        return new Response(null, { headers: { ...headers, "Content-Length": String(opened.size) } });
      }
      if (route === "image" && req.headers.get("if-none-match") === etag) {
        closeSync(opened.fd);
        return new Response(null, { status: 304, headers });
      }
      return new Response(fdStream(opened.fd), { headers: { ...headers, "Content-Length": String(opened.size) } });
    }

    // The person's marked-up images (a comment drawn on an image attachment).
    if (path === "/api/inbox/markups") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // The body is the image itself, so the stale-tab guard rides the query.
      const session = url.searchParams.get("serverSession");
      if (session !== null && checkServerSession({ serverSession: session }, serverSession) === "mismatch") {
        return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      }
      const markup = writeInboxMarkup(store.dir, new Uint8Array(await req.arrayBuffer()));
      return json({ path: markup.path, name: markup.name, url: `/api/inbox/markups/${markup.name}` });
    }
    const markupFile = /^\/api\/inbox\/markups\/([0-9a-f]{64}\.(?:png|jpg|webp))$/.exec(path);
    if (markupFile) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const markup = readInboxMarkup(store.dir, markupFile[1]!);
      if (!markup) return json({ error: "No such markup.", code: "markup_not_found" }, 404);
      return new Response(req.method === "HEAD" ? null : new Uint8Array(markup.bytes), {
        headers: {
          ...BYTE_GUARD_HEADERS,
          "Content-Type": markup.contentType,
          "Content-Security-Policy": INBOX_MESSAGE_IMAGE_CSP,
          "Content-Length": String(markup.bytes.length),
          "Cache-Control": "private, max-age=31536000, immutable",
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
