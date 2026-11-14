/**
 * Plannotator Inbox: an attached HTML page as a document of its own ("Pages
 * only", owner, 2026-11-05: an attached page shows web pictures, the window's
 * own text never does). The window builds the page's frame document as before
 * (HtmlViewer: the page, its `<base href>` at its folder's asset route, the
 * annotation bridge), hands it to the Inbox and frames the URL it gets back:
 *
 *   POST /api/inbox/pages        `{ html }` → `{ id, url }`: keep the document
 *   GET  /api/inbox/pages/:id    the document, under `INBOX_PAGE_CSP`
 *
 * Why served and not a srcdoc frame: a srcdoc inherits the window's CSP
 * (`img-src 'self' data: blob:`), and a policy inside the frame can only
 * narrow it. This document's own policy is the one the srcdoc frame had, plus
 * `https:` pictures. The window keeps loading no picture from the web.
 * Modelled on the HTML embeds (inbox-embeds.ts).
 *
 * The POST is a window write: the listener's cross-origin guard runs first (an
 * opaque-origin page sends `Origin: null`, refused). The GET is the frame's
 * own navigation. Not on the device door: the phone's surface draws its pages
 * itself.
 *
 * Kept in memory only, at most `maxEntries` and `maxBytes`, oldest out first.
 * The id is a keyed hash of the document (a key made per run), so a page sent
 * twice is kept once and no one who has not been sent the URL can name it. A
 * page that went (a restart, or pushed out) answers a small page that tells
 * the frame's host it is gone (`INBOX_PAGE_GONE_MESSAGE`), and the window posts
 * it again.
 */

import { createHmac, randomBytes } from "node:crypto";
import { SERVED_FRAME_GONE } from "@plannotator/core/html-embed";

export const INBOX_PAGES_PATH = "/api/inbox/pages";
const PAGE_PATH = /^\/api\/inbox\/pages\/([^/]+)$/;
const PAGE_ID = /^[0-9a-f]{32}$/;

/** The most one document may weigh: the 2 MB page the view route reads, rewritten, plus the inline bridge and theme. */
export const INBOX_PAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The page document's policy: what its srcdoc frame inherited from the window
 * (`WINDOW_CSP` in inbox.ts), plus web pictures (`https:` and plain `http:`,
 * local servers included: every picture a page names should show), and
 * sandboxed by the header too, so the page is an opaque origin even opened as
 * a tab of its own. Video and audio as the window's (`'self'`, data: and
 * blob:, never the web): the web is for pictures only.
 * `'self'` keeps the page's folder (its `<base href>`), its nested pages and
 * its own pictures from anywhere on this computer (their tokens, html-assets).
 */
export const INBOX_PAGE_CSP = [
  "sandbox allow-scripts allow-modals",
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** What a page that is no longer kept says to the window that framed it (HtmlViewer's `frameUrl`). */
export const INBOX_PAGE_GONE_MESSAGE = SERVED_FRAME_GONE;

const GONE_PAGE = `<!doctype html><meta charset="utf-8"><script>parent.postMessage({ type: ${JSON.stringify(INBOX_PAGE_GONE_MESSAGE)} }, "*");</script>`;
const GONE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'";

/** A page document's headers. */
export function inboxPageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": INBOX_PAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    // No Referer on the page's requests: a web picture's site never learns the Inbox's URL.
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Kept by id while this Inbox runs; a restart forgets it, so never cached.
    "Cache-Control": "no-store",
  };
}

export function createInboxPages(options: {
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  maxEntries?: number;
  maxBytes?: number;
}) {
  const { json } = options;
  const maxEntries = options.maxEntries ?? 64;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const key = randomBytes(32);
  const idOf = (html: string) => createHmac("sha256", key).update(html).digest("hex").slice(0, 32);
  /** id → document, oldest first (a hit moves to the end). */
  const pages = new Map<string, string>();
  let bytes = 0;

  const keep = (html: string): string => {
    const id = idOf(html);
    const had = pages.get(id);
    if (had !== undefined) {
      pages.delete(id);
      pages.set(id, had);
      return id;
    }
    pages.set(id, html);
    bytes += Buffer.byteLength(html);
    for (const [oldId, old] of pages) {
      if (pages.size <= maxEntries && bytes <= maxBytes) break;
      if (oldId === id) break;
      pages.delete(oldId);
      bytes -= Buffer.byteLength(old);
    }
    return id;
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === INBOX_PAGES_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST.", code: "method_not_allowed" }, 405);
      const body = await options.readBody(req);
      if (typeof body.html !== "string" || body.html.trim() === "") {
        return json({ error: "html: the page, a non-empty string.", code: "validation_error" }, 400);
      }
      if (Buffer.byteLength(body.html) > INBOX_PAGE_MAX_BYTES) {
        return json({ error: `html: at most ${INBOX_PAGE_MAX_BYTES} bytes.`, code: "page_too_large" }, 413);
      }
      const id = keep(body.html);
      return json({ id, url: `${INBOX_PAGES_PATH}/${id}` });
    }
    const match = PAGE_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
    const id = match[1]!;
    const page = PAGE_ID.test(id) ? pages.get(id) : undefined;
    if (page === undefined) {
      return new Response(req.method === "HEAD" ? null : GONE_PAGE, {
        status: 404,
        headers: { ...inboxPageHeaders(), "Content-Security-Policy": GONE_CSP },
      });
    }
    return new Response(req.method === "HEAD" ? null : page, { headers: inboxPageHeaders() });
  };

  return { route, size: () => pages.size, bytes: () => bytes };
}
