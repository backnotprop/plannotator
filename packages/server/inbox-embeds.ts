/**
 * Plannotator Inbox: the documents behind live HTML embeds (approval
 * "inbox-inline-html", 2026-10-28; the format and the policy are
 * @plannotator/core/html-embed). The window hands the Inbox a fence's HTML
 * and frames the document it gets back:
 *
 *   POST /api/inbox/embeds        `{ html }` → `{ id, url }`: keep the page (content-addressed)
 *   GET  /api/inbox/embeds/:id    the page, built by `buildEmbedDocument`, under `EMBED_RESPONSE_CSP`
 *
 * A block the person is commenting on (the pen under it; the owner's pick
 * "A · In place", 2026-11-20) is framed from a second document, which the
 * window builds: the same page with ui's annotation bridge inlined. It
 * cannot load the bridge from this server (`'self'` is never a source), so it
 * is kept and served as a whole, under the very same headers:
 *
 *   POST /api/inbox/embed-pages        `{ html }` → `{ id, url }`: keep the window's document
 *   GET  /api/inbox/embed-pages/:id    that document, under `EMBED_RESPONSE_CSP`
 *
 * (`createInboxEmbedPages`: the attached pages' store, inbox-pages.ts, with
 * the embed's headers; an id no one can guess, and a document that went says
 * so to its frame, which posts it again.)
 *
 * Why served and not a srcdoc frame: a srcdoc inherits the window's CSP,
 * which loads nothing from the web, and the owner chose pages that may. The
 * response's own policy sandboxes the page (an opaque origin, even opened as a
 * tab of its own) and lets it load over HTTPS only, never from this server.
 *
 * The POST is a window write: the listener's cross-origin guard runs first,
 * as for every write (an opaque-origin page sends `Origin: null`, refused).
 * No serverSession: keeping a page changes nothing a stale tab could undo.
 * The GET is the frame's own navigation, on the window's origin. Not on the
 * device door: phones do not draw embeds yet.
 *
 * Pages are kept in memory only, at most `maxEntries` and `maxBytes`, oldest
 * out first. The id is the content's hash, so a page sent twice is kept once,
 * and a frame whose page went (a restart) gets 404 until the window asks
 * again; the window always posts before it frames.
 */

import { createHash } from "node:crypto";
import { buildEmbedDocument, EMBED_ANNOTATABLE_MAX_BYTES, EMBED_ID, EMBED_MAX_BYTES, EMBED_RESPONSE_CSP } from "@plannotator/core/html-embed";
import { NO_FRAME_ANCESTORS, withFrameAncestors } from "./inbox-framing";
import { createInboxPages } from "./inbox-pages";

export const INBOX_EMBEDS_PATH = "/api/inbox/embeds";
/** The annotatable documents of html blocks (the window builds them; see the module comment). */
export const INBOX_EMBED_PAGES_PATH = "/api/inbox/embed-pages";
const EMBED_PAGE_PATH = /^\/api\/inbox\/embed-pages\/([^/]+)$/;
const EMBED_PATH = /^\/api\/inbox\/embeds\/([^/]+)$/;

/** An embed document's headers; `framers`: the app origins that may frame the window (inbox-framing.ts). */
export function inboxEmbedHeaders(framers: readonly string[] = NO_FRAME_ANCESTORS): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": withFrameAncestors(EMBED_RESPONSE_CSP, framers),
    "X-Content-Type-Options": "nosniff",
    // No Referer on the page's requests.
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Content-addressed: the bytes behind an id never change.
    "Cache-Control": "private, max-age=86400, immutable",
  };
}

export function embedIdOf(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 32);
}

export function createInboxEmbeds(options: {
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  maxEntries?: number;
  maxBytes?: number;
}) {
  const { json } = options;
  const maxEntries = options.maxEntries ?? 500;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  /** id → built document, oldest first (a hit moves to the end). */
  const pages = new Map<string, string>();
  let bytes = 0;

  const keep = (html: string): string => {
    const id = embedIdOf(html);
    const had = pages.get(id);
    if (had !== undefined) {
      pages.delete(id);
      pages.set(id, had);
      return id;
    }
    const page = buildEmbedDocument(html);
    pages.set(id, page);
    bytes += Buffer.byteLength(page);
    for (const [oldId, old] of pages) {
      if (pages.size <= maxEntries && bytes <= maxBytes) break;
      if (oldId === id) break;
      pages.delete(oldId);
      bytes -= Buffer.byteLength(old);
    }
    return id;
  };

  const route = async (req: Request, url: URL, framers: readonly string[] = NO_FRAME_ANCESTORS): Promise<Response | null> => {
    if (url.pathname === INBOX_EMBEDS_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST.", code: "method_not_allowed" }, 405);
      const body = await options.readBody(req);
      if (typeof body.html !== "string" || body.html.trim() === "") {
        return json({ error: "html: the page, a non-empty string.", code: "validation_error" }, 400);
      }
      if (Buffer.byteLength(body.html) > EMBED_MAX_BYTES) {
        return json({ error: `html: at most ${EMBED_MAX_BYTES} bytes.`, code: "embed_too_large" }, 413);
      }
      const id = keep(body.html);
      return json({ id, url: `${INBOX_EMBEDS_PATH}/${id}` });
    }
    const match = EMBED_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
    const id = match[1]!;
    const page = EMBED_ID.test(id) ? pages.get(id) : undefined;
    if (page === undefined) return json({ error: "No such embed.", code: "not_found" }, 404);
    return new Response(req.method === "HEAD" ? null : page, { headers: inboxEmbedHeaders(framers) });
  };

  return { route, size: () => pages.size };
}

/**
 * An annotatable html block's document as the window built it (the block's
 * page and the annotation bridge), served under the embed's own headers:
 * `inboxEmbedHeaders`, with only the cache line changed, because a restart
 * forgets the document (the embed's own is content-addressed).
 */
export function inboxEmbedPageHeaders(framers: readonly string[] = NO_FRAME_ANCESTORS): Record<string, string> {
  return { ...inboxEmbedHeaders(framers), "Cache-Control": "no-store" };
}

export function createInboxEmbedPages(options: {
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  maxEntries?: number;
  maxBytes?: number;
}) {
  const pages = createInboxPages({
    ...options,
    kind: { path: INBOX_EMBED_PAGES_PATH, pattern: EMBED_PAGE_PATH, headers: inboxEmbedPageHeaders, maxPageBytes: EMBED_ANNOTATABLE_MAX_BYTES },
  });
  const route = async (req: Request, url: URL, framers: readonly string[] = NO_FRAME_ANCESTORS): Promise<Response | null> => {
    if (url.pathname !== INBOX_EMBED_PAGES_PATH && !EMBED_PAGE_PATH.test(url.pathname)) return null;
    return pages.route(req, url, framers);
  };
  return { ...pages, route };
}
