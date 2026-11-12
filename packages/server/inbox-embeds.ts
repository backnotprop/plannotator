import { createHash } from "node:crypto";
import { buildEmbedDocument, EMBED_ID, EMBED_MAX_BYTES, EMBED_RESPONSE_CSP } from "@plannotator/core/html-embed";

export const INBOX_EMBEDS_PATH = "/api/inbox/embeds";
const EMBED_PATH = /^\/api\/inbox\/embeds\/([^/]+)$/;

export function inboxEmbedHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": EMBED_RESPONSE_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
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

  const route = async (req: Request, url: URL): Promise<Response | null> => {
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
    return new Response(req.method === "HEAD" ? null : page, { headers: inboxEmbedHeaders() });
  };

  return { route, size: () => pages.size };
}
