/**
 * Plannotator Inbox: the routes for attachments, annotations and deleting
 * (step 2 of the Inbox plan), mounted at the end of the Inbox server's route
 * table (packages/server/inbox.ts) behind its Host, Origin and same-origin
 * guards.
 *
 * A file is reached ONLY by its attachment id: there is no route that takes a
 * bare path (`markdown-image` takes only an image the Markdown file itself
 * shows, relative to its folder). The current file is read through its record with the rules in
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
 * `sandbox allow-scripts allow-modals` CSP, inside Plannotator's sandboxed HtmlViewer, so
 * its relative images and frames load from the file's own folder and never
 * draw the Inbox inside itself (#1554).
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import type { FileHandle } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, relative as relativeTo, resolve as resolvePath, sep } from "node:path";
import { htmlAssetPathRefused, isWithinDirectory } from "@plannotator/shared/html-assets-node";
import { HTML_ASSET_DOCUMENT_CSP, htmlAssetDocumentHeaders, MAX_HTML_ASSET_DOCUMENT_BYTES, refusesHiddenHtmlAssetPath } from "@plannotator/shared/html-assets";
import { INBOX_ANNOTATION_CURRENT, isInboxTextKind, readInboxAttachmentKind, type InboxAttachment } from "@plannotator/core/inbox-types";
import {
  checkCurrent,
  inboxAttachmentState,
  isPdfHead,
  openInboxAttachmentVersion,
  readInboxAttachmentText,
} from "@plannotator/shared/inbox/attachments";
import { INBOX_MESSAGE_IMAGE_CSP, readInboxMessageImageAsync } from "@plannotator/shared/inbox/message-images";
import { inboxImageResponse } from "./inbox-message-images";
import { readInboxMarkup, readInboxMarkupBody, writeInboxMarkup } from "@plannotator/shared/inbox/markups";
import { readImageDimensions, sniffImageContentType } from "@plannotator/shared/review-image";
import { sniffInboxVideo } from "@plannotator/shared/inbox/video";
import { byteRangeResponse, decideByteRange, handleRangeStream } from "./inbox-byte-range";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { createHtmlAssetRegistry } from "./html-assets";
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, MAX_REVIEW_IMAGE_PREVIEW_PIXELS } from "@plannotator/shared/diff-paths";

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

/**
 * A file handle as a response body, read in 1 MiB chunks: the Range routes'
 * stream (inbox-byte-range.ts), so the handle is closed at the end, on a
 * cancel (after any read in flight), and by the idle watchdog when a reader
 * vanishes.
 */
function handleStream(handle: FileHandle, idleMs?: number): ReadableStream<Uint8Array> {
  return handleRangeStream(handle, 0, undefined, { idleMs });
}

/**
 * The asset paths the Inbox never serves from an attached HTML page's folder
 * (which may be a home folder): any segment starting with `.` (`.docker`,
 * `.ssh`, `.plannotator`) and the dotenv family. The same rule an annotate
 * folder session's widened asset root applies (`refusesHiddenHtmlAssetPath`).
 */
export const inboxRefusesAssetPath = refusesHiddenHtmlAssetPath;

/** A nested document in an attached page runs scripts but reaches no network. */
export const INBOX_HTML_DOCUMENT_CSP = `${HTML_ASSET_DOCUMENT_CSP}; connect-src 'none'`;

/**
 * The page `relativePath` names in the folder of the attached HTML page at
 * `attachedPath` (its realpath): its realpath and text. Refused (InboxError)
 * when the path is not a plain relative path, names a hidden segment or a
 * dotenv file (as requested or by where it leads), is not `.html`/`.htm`,
 * leads outside that folder, is not a regular file, or is over 2 MB.
 */
export async function readInboxLinkedPage(attachedPath: string, relativePath: string | null): Promise<{ path: string; text: string }> {
  const rel = (relativePath ?? "").replace(/\\/g, "/");
  if (!rel || rel.length > 2048 || /[\u0000-\u001f\u007f]/.test(rel) || rel.startsWith("/") || /^[a-z]:/i.test(rel)) {
    throw new InboxError("validation_error", "path: a path relative to the attached page's folder.", { field: "path" });
  }
  const segments = rel.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new InboxError("linked_page_outside", "Only pages in the attached page's own folder open here.");
  }
  const clean = segments.join("/");
  const name = segments[segments.length - 1]!;
  if (!/\.html?$/i.test(name)) throw new InboxError("linked_page_not_html", `${name} is not an HTML page.`);
  const root = dirname(attachedPath);
  const target = resolvePath(root, clean);
  if (!isWithinDirectory(target, root)) throw new InboxError("linked_page_outside", "Only pages in the attached page's own folder open here.");
  if (htmlAssetPathRefused(root, clean, inboxRefusesAssetPath)) {
    throw new InboxError("linked_page_refused", "Plannotator does not open hidden files or .env files.");
  }
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new InboxError("linked_page_missing", `${name} is not there.`);
  }
  // Judged again on the resolved path (a symlink inside the folder that leads out). This alone does not
  // cover a folder swapped for a link after realpath: the dev/ino check below the open does.
  if (!isWithinDirectory(real, root)) throw new InboxError("linked_page_outside", "Only pages in the attached page's own folder open here.");
  if (inboxRefusesAssetPath(relativeTo(root, real).split(sep).join("/"))) {
    throw new InboxError("linked_page_refused", "Plannotator does not open hidden files or .env files.");
  }
  // The handle is opened on the realpath without following a link. O_NOFOLLOW covers
  // only the last segment, so once open the realpath must still lead to the very
  // file the descriptor holds (dev and ino): a parent folder swapped for a symlink
  // between realpath and open is caught.
  let handle: FileHandle;
  try {
    handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    throw new InboxError("linked_page_missing", `${name} could not be read.`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InboxError("linked_page_missing", `${name} is not a file.`);
    if (stat.size > MAX_HTML_ASSET_DOCUMENT_BYTES) throw new InboxError("linked_page_too_large", `${name} is too large to show here (over 2 MB).`);
    if (!(await openedIsReal(handle, real, stat))) throw new InboxError("linked_page_outside", "Only pages in the attached page's own folder open here.");
    // At most the cap plus one byte, so a file that grows after the stat is never read whole.
    const buffer = Buffer.alloc(MAX_HTML_ASSET_DOCUMENT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_HTML_ASSET_DOCUMENT_BYTES) throw new InboxError("linked_page_too_large", `${name} is too large to show here (over 2 MB).`);
    return { path: real, text: buffer.subarray(0, length).toString("utf8") };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * The descriptor holds the file `real` names. On Linux the descriptor's own
 * path (`/proc/self/fd/N`) says where it really is, whatever the folders did
 * since. Elsewhere the realpath must be unchanged and lead to the same dev
 * and ino, judged with an lstat on both sides of the realpath: a parent
 * swapped for a symlink between one realpath and one lstat would otherwise
 * let the lstat follow it to the very file the descriptor holds.
 */
async function openedIsReal(handle: FileHandle, real: string, opened: { dev: number; ino: number }): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      return (await readlink(`/proc/self/fd/${handle.fd}`)) === real;
    } catch {
      // No /proc (a container without it): the checks below.
    }
  }
  return (await stillSameFile(real, opened)) && (await stillSameFile(real, opened));
}

/** The path still leads to the file a descriptor holds: the same dev and ino before and after its realpath, which is unchanged. */
async function stillSameFile(real: string, opened: { dev: number; ino: number }): Promise<boolean> {
  try {
    const same = async () => {
      const at = await lstat(real);
      return at.isFile() && at.dev === opened.dev && at.ino === opened.ino;
    };
    if (!(await same())) return false;
    if ((await realpath(real)) !== real) return false;
    return await same();
  } catch {
    return false;
  }
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
  /** How long a streamed answer may go unread before its file handle closes. Default `STREAM_IDLE_CLOSE_MS`; tests shorten it. */
  streamIdleMs?: number;
  /** Ask for the thread's uncaptured message images to be copied in the background (inbox-message-images.ts); a read never waits for it. */
  scheduleImageCapture?: (threadId: string) => void;
}

type Version = "current" | "sent";

function versionOf(url: URL): Version {
  const value = url.searchParams.get("version");
  if (value === null || value === "" || value === "current") return "current";
  if (value === "sent") return "sent";
  throw new InboxError("validation_error", "version: \"current\" or \"sent\".", { field: "version" });
}

/** One version's whole text (a text kind), or the reason it cannot be read: missing, changed, or too large to read whole (413). */
async function readVersion(store: InboxStore, attachment: InboxAttachment, version: Version): Promise<Buffer> {
  const read = await readInboxAttachmentText(store.dir, attachment, version);
  if (!read.ok) throw new InboxError(read.code, read.message);
  return read.bytes;
}

export function createInboxAttachmentRoutes(context: InboxAttachmentRoutesContext) {
  const { store, serverSession } = context;
  const htmlAssets = createHtmlAssetRegistry({ refuseAssetPath: inboxRefusesAssetPath, documentCsp: INBOX_HTML_DOCUMENT_CSP });

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
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const threadId = threadAttachments[1]!;
      if (!store.thread(threadId)) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      context.scheduleImageCapture?.(threadId);
      return json({
        serverSession,
        // A changed large file is judged by its stat here and hashed when it is opened.
        attachments: await Promise.all(store.threadAttachments(threadId).map(({ attachment, message }) => inboxAttachmentState(attachment, message.id, { hash: "small" }))),
        // The images the messages show, captured as files (additive: a reader that does not know it draws nothing extra).
        inline_images: await Promise.all(store.threadInlineImages(threadId).map(({ attachment, message }) => inboxAttachmentState(attachment, message.id, { hash: "small" }))),
        annotations: store.pendingAnnotations(threadId),
      });
    }

    // Only images referenced by the selected Markdown version, relative to the file itself.
    const markdownImage = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/markdown-image$/.exec(path);
    if (markdownImage) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET or HEAD." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment, message } = attachmentOf(markdownImage[1]!);
      if (attachment.kind !== "markdown") throw new InboxError("validation_error", "Only Markdown attachments show inline images.");
      const project = store.project(message.project_id);
      if (!project) throw new InboxError("project_not_found", "The attachment's project is gone.");
      const body = (await readVersion(store, attachment, versionOf(url))).toString("utf8");
      return inboxImageResponse(req, await readInboxMessageImageAsync({
        body,
        root: project.root,
        base: dirname(attachment.path),
        path: url.searchParams.get("path"),
        anywhere: message.author.kind === "agent",
      }));
    }

    const view = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/view$/.exec(path);
    if (view) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment, message } = attachmentOf(view[1]!);
      if (!isInboxTextKind(attachment.kind)) throw notText(attachment);
      const version = versionOf(url);
      const text = (await readVersion(store, attachment, version)).toString("utf8");
      return json({
        serverSession,
        attachment: await inboxAttachmentState(attachment, message.id),
        version: version === "sent" ? attachment.sent_sha256 : INBOX_ANNOTATION_CURRENT,
        text,
        // The page as annotate serves it: a <base href> at its own folder's asset route.
        html: attachment.kind === "html" ? htmlAssets.rewriteHtml(text, attachment.path) : null,
      });
    }

    // An attached HTML page in a tab of its own ("Open in" → Browser): read only,
    // under the sandbox attached pages already get, from its own folder.
    const page = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/page$/.exec(path);
    if (page) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(page[1]!);
      if (readInboxAttachmentKind(attachment.kind) !== "html") {
        throw new InboxError("attachment_not_html", `${attachment.name} is not an HTML page.`);
      }
      const version = versionOf(url);
      if (version === "current") {
        const check = checkCurrent(attachment);
        if (!check.ok) throw new InboxError(check.unavailable.code, check.unavailable.message);
        // The file at its own folder's asset URL: relative assets, #anchors and frames
        // resolve natively, with the document CSP. A name the asset route refuses
        // (a hidden page, `.draft.html`) or a page over its size is served below instead.
        const target = htmlAssets.documentUrl(attachment.path);
        const name = basename(attachment.path);
        if (target && /\.html?$/i.test(name) && !inboxRefusesAssetPath(name) && check.stat.size <= MAX_HTML_ASSET_DOCUMENT_BYTES) {
          return new Response(null, { status: 303, headers: { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
        }
      }
      // The sent bytes (or a page the asset route will not serve), with a <base href> at its folder.
      const html = htmlAssets.rewriteHtml((await readVersion(store, attachment, version)).toString("utf8"), attachment.path);
      return new Response(req.method === "HEAD" ? null : html, {
        headers: { ...htmlAssetDocumentHeaders(INBOX_HTML_DOCUMENT_CSP), ...BYTE_GUARD_HEADERS, "Referrer-Policy": "no-referrer" },
      });
    }

    // Another page an attached HTML page links to (`<a href="B-cards.html">`), not
    // attached itself: shown read-only in the same pane. Reached by the attachment's
    // id plus a path relative to the attached page's own folder (never an absolute
    // path), with the asset route's rules: inside that folder by realpath, no hidden
    // segment or dotenv name, `.html`/`.htm`, at most 2 MB.
    const linked = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/linked-page$/.exec(path);
    if (linked) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(linked[1]!);
      if (readInboxAttachmentKind(attachment.kind) !== "html") {
        throw new InboxError("attachment_not_html", `${attachment.name} is not an HTML page.`);
      }
      const page = await readInboxLinkedPage(attachment.path, url.searchParams.get("path"));
      return json({
        serverSession,
        path: page.path,
        name: basename(page.path),
        // The page as annotate serves it: a <base href> at its own folder's asset route.
        html: htmlAssets.rewriteHtml(page.text, page.path),
        // Open in new tab: the file at its folder's asset URL, under the document CSP.
        url: htmlAssets.documentUrl(page.path),
      });
    }

    const raw = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)$/.exec(path);
    if (raw) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(raw[1]!);
      // A binary kind is never streamed as text: it has the image and download routes.
      if (!isInboxTextKind(attachment.kind)) throw notText(attachment);
      const bytes = await readVersion(store, attachment, versionOf(url));
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

    // A film for `<video src>` and a native player: Range from the descriptor
    // the one check opened (inbox-byte-range.ts), never the whole file at once.
    const videoRoute = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/video$/.exec(path);
    if (videoRoute) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(videoRoute[1]!);
      if (readInboxAttachmentKind(attachment.kind) !== "video") {
        throw new InboxError("attachment_not_video", `${attachment.name} is not a video; download it instead.`);
      }
      const opened = await openInboxAttachmentVersion(store.dir, attachment, versionOf(url), { hash: "none" });
      if (!opened.ok) throw new InboxError(opened.code, opened.message);
      // The type of the bytes served, sniffed now (the sent blob too): never the record's, never the name's.
      const sniffed = sniffInboxVideo(opened.head);
      if (!sniffed) {
        await opened.handle.close().catch(() => {});
        throw new InboxError("attachment_not_video", `${attachment.name} is no longer a video.`);
      }
      const decision = decideByteRange(req.headers.get("range"), opened.size, { ifRange: req.headers.get("if-range"), etag: opened.etag });
      return byteRangeResponse(opened.handle, opened.size, decision, {
        ...BYTE_GUARD_HEADERS,
        "Content-Type": sniffed,
        "Content-Security-Policy": INBOX_MESSAGE_IMAGE_CSP,
        "Content-Disposition": contentDisposition("inline", attachment.name),
        "Cache-Control": "private, no-cache",
        ETag: opened.etag,
      }, { idleMs: context.streamIdleMs });
    }

    const bytesRoute = /^\/api\/inbox\/attachments\/(att_[A-Za-z0-9]+)\/(image|download)$/.exec(path);
    if (bytesRoute) {
      if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET." }, 405);
      if (crossSite(req)) return json(CROSS_SITE_BODY, 403);
      const { attachment } = attachmentOf(bytesRoute[1]!);
      const route = bytesRoute[2] as "image" | "download";
      const kind = readInboxAttachmentKind(attachment.kind);
      if (route === "image" && kind !== "image") throw new InboxError("attachment_not_image", `${attachment.name} is not an image; download it instead.`);
      // An image a message shows: refused by its size before the image route hashes it whole.
      if ("ref" in attachment && versionOf(url) === "current") {
        const check = checkCurrent(attachment);
        if (check.ok && check.stat.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) {
          return json({ error: `${attachment.name} is larger than 10 MB; open the version it sent.`, code: "image_too_large" }, 413);
        }
      }
      // The image route's ETag is the hash; a download needs none, so a large file is not read twice.
      const opened = await openInboxAttachmentVersion(store.dir, attachment, versionOf(url), { hash: route === "image" ? "always" : "none" });
      if (!opened.ok) throw new InboxError(opened.code, opened.message);
      // An image a message's body shows keeps the message-image route's byte cap on the file as it is now, for a download too.
      if ("ref" in attachment && opened.size > MAX_REVIEW_IMAGE_PREVIEW_BYTES) {
        await opened.handle.close().catch(() => {});
        return json({ error: `${attachment.name} is larger than 10 MB; open the version it sent.`, code: "image_too_large" }, 413);
      }
      let contentType: string;
      const extra: Record<string, string> = {};
      if (route === "image") {
        // The type of the bytes served, sniffed now: never the record's, never the name's.
        const sniffed = sniffImageContentType(opened.head);
        if (!sniffed) {
          await opened.handle.close().catch(() => {});
          throw new InboxError("attachment_not_image", `${attachment.name} is no longer an image.`);
        }
        contentType = sniffed;
        const dims = readImageDimensions(opened.head, sniffed);
        // An image a message's body shows keeps the message-image route's caps on the file as it is now.
        if ("ref" in attachment && dims && dims.width * dims.height > MAX_REVIEW_IMAGE_PREVIEW_PIXELS) {
          await opened.handle.close().catch(() => {});
          return json({ error: `${attachment.name} is larger than 10 MB or 50 megapixels; open the version it sent.`, code: "image_too_large" }, 413);
        }
        if (dims) {
          extra["X-Image-Width"] = String(dims.width);
          extra["X-Image-Height"] = String(dims.height);
        }
      } else {
        contentType = kind === "pdf" && isPdfHead(opened.head) ? "application/pdf" : "application/octet-stream";
      }
      // The image's ETag is its hash; a download's is the version's validator (no read: a seek is a request).
      const etag = route === "image" ? (opened.sha256 ? `"${opened.sha256}"` : null) : opened.etag;
      const headers: Record<string, string> = {
        ...BYTE_GUARD_HEADERS,
        ...extra,
        "Content-Type": contentType,
        "Content-Security-Policy": route === "image" ? INBOX_MESSAGE_IMAGE_CSP : "sandbox",
        "Content-Disposition": contentDisposition(route === "image" ? "inline" : "attachment", attachment.name),
        "Cache-Control": route === "image" ? "private, no-cache" : "no-store",
        ...(etag ? { ETag: etag } : {}),
      };
      if (route === "download") {
        // Any file streams to a native player (or resumes) by Range, from the same descriptor.
        const decision = decideByteRange(req.headers.get("range"), opened.size, { ifRange: req.headers.get("if-range"), etag: opened.etag });
        return byteRangeResponse(opened.handle, opened.size, decision, headers, { head: req.method === "HEAD", idleMs: context.streamIdleMs });
      }
      if (req.method === "HEAD") {
        await opened.handle.close().catch(() => {});
        return new Response(null, { headers: { ...headers, "Content-Length": String(opened.size) } });
      }
      if (route === "image" && etag && req.headers.get("if-none-match") === etag) {
        await opened.handle.close().catch(() => {});
        return new Response(null, { status: 304, headers });
      }
      return new Response(handleStream(opened.handle, context.streamIdleMs), { headers: { ...headers, "Content-Length": String(opened.size) } });
    }

    // The person's marked-up images (a comment drawn on an image attachment).
    if (path === "/api/inbox/markups") {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      // The body is the image itself, so the stale-tab guard rides the query.
      const session = url.searchParams.get("serverSession");
      if (session !== null && checkServerSession({ serverSession: session }, serverSession) === "mismatch") {
        return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      }
      const markup = writeInboxMarkup(store.dir, await readInboxMarkupBody(req.body, req.headers.get("content-length")));
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

    // A comment on the text of an agent's message (approval
    // "inbox-message-comments"): the words the person selected, kept with the
    // attachments' annotations (removed by the same remove route, sent with
    // the reply the same way).
    const messageAnnotation = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/annotations$/.exec(path);
    if (messageAnnotation) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      return json({ annotation: store.saveMessageAnnotation(messageAnnotation[1]!, body.annotation) });
    }

    // A comment on the diff of the guided review a message carries: the review
    // app's line comment, kept with the attachments' annotations (removed by
    // the same remove route, sent with the reply the same way).
    const guideAnnotation = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/guide\/annotations$/.exec(path);
    if (guideAnnotation) {
      if (req.method !== "POST") return json({ error: "Use POST." }, 405);
      const body = await guardedBody(req);
      if (body instanceof Response) return body;
      return json({ annotation: store.saveGuideAnnotation(guideAnnotation[1]!, body.annotation) });
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
