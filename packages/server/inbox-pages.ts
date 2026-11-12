import { createHmac, randomBytes } from "node:crypto";
import { SERVED_FRAME_GONE } from "@plannotator/core/html-embed";

export const INBOX_PAGES_PATH = "/api/inbox/pages";
const PAGE_PATH = /^\/api\/inbox\/pages\/([^/]+)$/;
const PAGE_ID = /^[0-9a-f]{32}$/;

export const INBOX_PAGE_MAX_BYTES = 8 * 1024 * 1024;

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

export const INBOX_PAGE_GONE_MESSAGE = SERVED_FRAME_GONE;

const GONE_PAGE = `<!doctype html><meta charset="utf-8"><script>parent.postMessage({ type: ${JSON.stringify(INBOX_PAGE_GONE_MESSAGE)} }, "*");</script>`;
const GONE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; frame-ancestors 'self'";

export function inboxPageHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": INBOX_PAGE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
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
