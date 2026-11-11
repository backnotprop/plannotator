/** Only names listed in inbox-tour-content.ts are served, so a name never reaches the file system. The mock page runs at an opaque origin (`sandbox allow-scripts`, no `allow-same-origin`). */
import { decideByteRange } from "./inbox-byte-range";
import { INBOX_TOUR_ASSET_PATHS, INBOX_TOUR_FIXTURE_PATH } from "./inbox-tour-content";

export const INBOX_TOUR_PREFIX = "/api/inbox/tour/";
export const INBOX_TOUR_FIXTURE_ROUTE = "/api/inbox/tour/fixture.json";
export const INBOX_TOUR_ASSETS_ROUTE = "/api/inbox/tour/assets/";

const IMAGE_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
/** Sandboxed without `allow-same-origin`, and it may load nothing: pictures, video and audio from data: and blob: only. */
export const INBOX_TOUR_MOCK_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

const etags = new Map<string, string>();

async function etagOf(path: string, bytes: ArrayBuffer): Promise<string> {
  const known = etags.get(path);
  if (known) return known;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const tag = `"${[...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
  etags.set(path, tag);
  return tag;
}

function typeOf(name: string): string | null {
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".html")) return "text/html; charset=utf-8";
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".md")) return "text/plain; charset=utf-8";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  return null;
}

function refusal(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  });
}

export async function handleInboxTourRequest(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith(INBOX_TOUR_PREFIX)) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return refusal(405, "method_not_allowed", "Use GET.");
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") return refusal(403, "cross_origin", "Cross-origin requests are not accepted.");
  let name: string;
  let file: string | undefined;
  if (path === INBOX_TOUR_FIXTURE_ROUTE) {
    name = "fixture.json";
    file = INBOX_TOUR_FIXTURE_PATH;
  } else if (path.startsWith(INBOX_TOUR_ASSETS_ROUTE)) {
    name = path.slice(INBOX_TOUR_ASSETS_ROUTE.length);
    file = Object.hasOwn(INBOX_TOUR_ASSET_PATHS, name) ? INBOX_TOUR_ASSET_PATHS[name] : undefined;
  } else {
    return refusal(404, "not_found", "Not found");
  }
  const type = typeOf(name);
  if (!file || !type) return refusal(404, "tour_asset_not_found", "No such tour asset.");
  let bytes: ArrayBuffer;
  try {
    bytes = await Bun.file(file).arrayBuffer();
  } catch {
    return refusal(404, "tour_asset_not_found", "The tour's content is not in this build.");
  }
  const etag = await etagOf(file, bytes);
  const headers: Record<string, string> = {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "private, no-cache",
    ETag: etag,
  };
  if (name.endsWith(".webp")) headers["Content-Security-Policy"] = IMAGE_CSP;
  if (name.endsWith(".html")) headers["Content-Security-Policy"] = INBOX_TOUR_MOCK_CSP;
  if (name.endsWith(".json") || name.endsWith(".md")) headers["Content-Security-Policy"] = "sandbox; default-src 'none'";
  if (name.endsWith(".mp4")) {
    // HTTP Range over the bytes already in memory (Safari plays no video without it).
    headers["Content-Security-Policy"] = IMAGE_CSP;
    headers["Accept-Ranges"] = "bytes";
    const decided = decideByteRange(req.headers.get("range"), bytes.byteLength, { ifRange: req.headers.get("if-range"), etag });
    if (decided.kind === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${bytes.byteLength}` } });
    if (decided.kind === "partial") {
      const part = bytes.slice(decided.start, decided.end + 1);
      return new Response(req.method === "HEAD" ? null : part, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${decided.start}-${decided.end}/${bytes.byteLength}`, "Content-Length": String(part.byteLength) },
      });
    }
  }
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(req.method === "HEAD" ? null : bytes, { status: 200, headers });
}
