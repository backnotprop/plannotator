/**
 * Negotiated brotli/gzip compression for the single-file app HTML, only for sessions whose browser can be on another device (remote mode, `--tailscale`). A local session is never compressed: on loopback it measured slower cold.
 * The decision ignores the client address: `tailscale serve` connects from 127.0.0.1 too.
 * Browsers advertise `br` only to secure contexts, so direct remote http gets gzip and `--tailscale` (HTTPS) gets brotli.
 * Identity responses send the original string untouched; each body is compressed once per encoding and reused; a compression failure falls back to identity.
 */
import * as zlib from "node:zlib";

export type AppHtmlEncoding = "br" | "gzip" | "identity";

/** Brotli quality 5 balances ~0.2 s one-time CPU against size (q11 takes ~22 s); gzip level 6 is zlib's default. */
export const APP_HTML_BROTLI_QUALITY = 5;
export const APP_HTML_GZIP_LEVEL = 6;

const MAX_CACHED_BODIES = 8;

interface Coding {
  name: string;
  q: number;
}

function parseAcceptEncoding(header: string): Coding[] {
  const codings: Coding[] = [];
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.split(";");
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() !== "q") continue;
      const parsed = Number.parseFloat((value ?? "").trim());
      q = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
    }
    codings.push({ name, q });
  }
  return codings;
}

/** Highest q wins among br/gzip (ties prefer br); `q=0` refuses; `*` matches codings not listed; anything else is identity. */
export function negotiateAppHtmlEncoding(
  acceptEncoding: string | null | undefined,
): AppHtmlEncoding {
  if (!acceptEncoding) return "identity";
  const codings = parseAcceptEncoding(acceptEncoding);
  const wildcard = codings.find((c) => c.name === "*");
  const qualityOf = (name: string): number => {
    const explicit = codings.find((c) => c.name === name || (name === "gzip" && c.name === "x-gzip"));
    if (explicit) return explicit.q;
    return wildcard ? wildcard.q : 0;
  };
  const br = qualityOf("br");
  const gzip = qualityOf("gzip");
  if (br <= 0 && gzip <= 0) return "identity";
  return br >= gzip ? "br" : "gzip";
}

export function acceptsGzip(acceptEncoding: string | null | undefined): boolean {
  if (!acceptEncoding) return false;
  const codings = parseAcceptEncoding(acceptEncoding);
  const explicit = codings.find((c) => c.name === "gzip" || c.name === "x-gzip");
  if (explicit) return explicit.q > 0;
  const wildcard = codings.find((c) => c.name === "*");
  return wildcard ? wildcard.q > 0 : false;
}

interface CacheEntry {
  html: string;
  encoded: Partial<Record<"br" | "gzip", Promise<Buffer>>>;
}

/** Module-level on purpose: one compression per body per process, bounded to MAX_CACHED_BODIES, oldest evicted first. */
const cache: CacheEntry[] = [];

/** Compress once, uncached; the packed app's chunks use a cache of their own so they never evict the page. */
export function compressAppText(html: string, encoding: "br" | "gzip"): Promise<Buffer> {
  const input = Buffer.from(html, "utf8");
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === "br") {
      zlib.brotliCompress(
        input,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: APP_HTML_BROTLI_QUALITY,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          },
        },
        done,
      );
    } else {
      zlib.gzip(input, { level: APP_HTML_GZIP_LEVEL }, done);
    }
  });
}

export function encodeAppHtml(html: string, encoding: "br" | "gzip"): Promise<Buffer> {
  let entry = cache.find((e) => e.html === html);
  if (!entry) {
    entry = { html, encoded: {} };
    cache.push(entry);
    if (cache.length > MAX_CACHED_BODIES) cache.shift();
  }
  let pending = entry.encoded[encoding];
  if (!pending) {
    const owner = entry;
    pending = compressAppText(html, encoding);
    owner.encoded[encoding] = pending;
    // A failed compression must not poison later requests.
    pending.catch(() => {
      if (owner.encoded[encoding] === pending) delete owner.encoded[encoding];
    });
  }
  return pending;
}

export function likelyAppHtmlEncoding(tailnetPublished: boolean): "br" | "gzip" {
  return tailnetPublished ? "br" : "gzip";
}

/** Never throws; a failure is retried lazily by the request that needs it. */
export function prewarmAppHtml(html: string, encoding: "br" | "gzip"): void {
  encodeAppHtml(html, encoding).catch(() => {});
}

export interface PreparedAppHtml {
  encoding: AppHtmlEncoding;
  body: string | Buffer;
  headers: Record<string, string>;
}

const CONTENT_TYPE = "text/html";

/** `compress: false` returns the original string with `Content-Type` only. `contentType` lets other large text bodies share the negotiation and cache. */
export async function prepareAppHtml(
  html: string,
  acceptEncoding: string | null | undefined,
  compress: boolean,
  contentType: string = CONTENT_TYPE,
): Promise<PreparedAppHtml> {
  if (!compress) {
    return { encoding: "identity", body: html, headers: { "Content-Type": contentType } };
  }
  const encoding = negotiateAppHtmlEncoding(acceptEncoding);
  if (encoding !== "identity") {
    try {
      const body = await encodeAppHtml(html, encoding);
      return {
        encoding,
        body,
        headers: {
          "Content-Type": contentType,
          "Content-Encoding": encoding,
          "Content-Length": String(body.length),
          Vary: "Accept-Encoding",
        },
      };
    } catch (err) {
      console.error("[plannotator] App HTML compression failed; serving uncompressed:", err);
    }
  }
  return {
    encoding: "identity",
    body: html,
    headers: { "Content-Type": contentType, Vary: "Accept-Encoding" },
  };
}
