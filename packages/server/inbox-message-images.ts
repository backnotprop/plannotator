/**
 * Plannotator Inbox: `GET /api/inbox/messages/<id>/image?path=<src>`, the
 * images an agent's message shows (#1813). Mounted in the Inbox server's
 * route table (packages/server/inbox.ts), behind its Host allowlist; it sets
 * no CORS headers.
 *
 * Every decision is in packages/shared/inbox/message-images.ts: the path
 * must be an image the message's own body references, inside the message's
 * project (realpath, so `../` and symlink escapes are refused), an image by
 * extension and by its magic bytes, at most 10 MB. This file adds the
 * transport: a cross-site request is refused before anything is read, and
 * every answer carries nosniff, a sandbox CSP and a same-origin CORP, so
 * another site can neither embed nor read an image, and an SVG opened
 * directly never runs.
 */

import { isInboxId } from "@plannotator/core/inbox-types";
import { INBOX_MESSAGE_IMAGE_CSP, readInboxMessageImage } from "@plannotator/shared/inbox/message-images";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_MESSAGE_IMAGE_ROUTE = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/image$/;

const GUARD_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": INBOX_MESSAGE_IMAGE_CSP,
  "Cross-Origin-Resource-Policy": "same-origin",
};

function refuse(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { ...GUARD_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Answers the image route, or null when the path is not it. */
export function inboxMessageImageRoute(req: Request, url: URL, store: InboxStore): Response | null {
  const match = INBOX_MESSAGE_IMAGE_ROUTE.exec(url.pathname);
  if (!match) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method_not_allowed", "Use GET.");
  // The window's own <img> is same-origin; a typed URL is "none". A page on
  // another site (or another localhost port) never gets an answer.
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return refuse(403, "cross_origin", "Cross-origin requests are not accepted.");
  const id = match[1]!;
  const message = isInboxId("msg", id) ? store.message(id) : null;
  if (!message) return refuse(404, "message_not_found", `No message ${id}.`);
  const project = store.project(message.project_id);
  if (!project) return refuse(404, "project_not_found", "The message's project is gone.");

  const result = readInboxMessageImage({
    body: message.body,
    root: project.root,
    base: message.base_path ?? null,
    path: url.searchParams.get("path"),
  });
  if (!result.ok) return refuse(result.status, result.code, result.error);
  return new Response(req.method === "HEAD" ? null : new Uint8Array(result.bytes), {
    headers: {
      ...GUARD_HEADERS,
      "Content-Type": result.contentType,
      "Content-Length": String(result.bytes.byteLength),
      "Cache-Control": "private, no-cache",
    },
  });
}
