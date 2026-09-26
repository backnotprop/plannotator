/**
 * Negotiated compression for the single-file app HTML (#1617).
 *
 * Every Plannotator server answers its SPA catch-all with the whole app as one
 * HTML document (~24 MB plan, ~17 MB review). Over a slow tunnel that is the
 * entire load time, so a session reachable over a network sends the page
 * brotli- or gzip-compressed when the client says it can decode it.
 *
 * Shared by the Bun servers (`appHtmlResponse`) and the Pi node:http servers
 * (`prepareAppHtml`, vendored to Pi by `apps/pi-extension/vendor.sh`), so the
 * negotiation and the cache cannot drift between runtimes. Only `node:zlib` is
 * used, which both runtimes provide.
 *
 * Which sessions compress (the `compress` argument): remote mode
 * (PLANNOTATOR_REMOTE or SSH detection) and `--tailscale`-published sessions,
 * i.e. exactly the sessions whose browser can be on another device. A plain
 * local session never compresses and its response is unchanged, headers
 * included: on loopback the transfer is free, and measured cold loads were
 * ~0.17 s SLOWER with compression, because the first request waits on the
 * one-time ~0.2 s brotli pass. The decision deliberately ignores the client
 * address: `tailscale serve` connects from 127.0.0.1 too.
 *
 * Compressing sessions start the brotli pass at server start
 * (`prewarmAppHtml`), off the event loop, so the page is usually ready before
 * the first request. Gzip, which only browsers without br use (WebKit over
 * plain http advertises no br), is compressed lazily on its first request.
 *
 * Invariants:
 * - Identity (no `Accept-Encoding`, `identity`, `br;q=0, gzip;q=0`, the VS Code
 *   cookie proxy's forced `identity`) sends the original string untouched; a
 *   compressing session adds only `Vary: Accept-Encoding`.
 * - Each HTML body is compressed at most once per encoding per process, off the
 *   event loop (async zlib), and the result is reused for every later request;
 *   a request that arrives while compression is in flight awaits the same work.
 * - A compression failure falls back to identity rather than failing the page.
 */
import * as zlib from "node:zlib";

export type AppHtmlEncoding = "br" | "gzip" | "identity";

/**
 * Brotli quality 5: on the 24.7 MB plan HTML it takes ~0.2 s once and yields
 * 6.77 MB (q4: 7.13 MB in 0.11 s; q6: 6.70 MB in 0.29 s; q11: 6.1 MB in 22 s).
 * The 0.36 MB it saves over q4 is ~1.8 s on a 206 KB/s link, paid for with
 * ~0.1 s of one-time CPU. Gzip level 6 is zlib's default balance.
 */
export const APP_HTML_BROTLI_QUALITY = 5;
export const APP_HTML_GZIP_LEVEL = 6;

/** Only a handful of distinct app bodies exist per process; bound it anyway. */
const MAX_CACHED_BODIES = 4;

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

/**
 * Pick the encoding for an `Accept-Encoding` header value. The highest
 * q-value among br / gzip wins (ties prefer br); a coding listed with `q=0` is
 * refused, `*` stands for any coding not listed explicitly, and anything else
 * — including an absent header — is identity.
 */
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

interface CacheEntry {
  html: string;
  encoded: Partial<Record<"br" | "gzip", Promise<Buffer>>>;
}

const cache: CacheEntry[] = [];

function compress(html: string, encoding: "br" | "gzip"): Promise<Buffer> {
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

/** The cached compressed bytes of `html`, compressing on first use. */
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
    pending = compress(html, encoding);
    owner.encoded[encoding] = pending;
    // A failed compression must not poison later requests.
    pending.catch(() => {
      if (owner.encoded[encoding] === pending) delete owner.encoded[encoding];
    });
  }
  return pending;
}

/**
 * Start the brotli compression of `html` now, in the background, so the first
 * page load does not wait for it. Never throws; a failure is retried lazily by
 * the request that needs it.
 */
export function prewarmAppHtml(html: string): void {
  encodeAppHtml(html, "br").catch(() => {});
}

export interface PreparedAppHtml {
  encoding: AppHtmlEncoding;
  /** The original string for identity, else the compressed bytes. */
  body: string | Buffer;
  headers: Record<string, string>;
}

const CONTENT_TYPE = "text/html";

/**
 * Negotiate and produce the body + headers for one app-HTML response.
 * `compress: false` (a local-only session) returns exactly the pre-#1617
 * response: the original string with `Content-Type` only.
 */
export async function prepareAppHtml(
  html: string,
  acceptEncoding: string | null | undefined,
  compress: boolean,
): Promise<PreparedAppHtml> {
  if (!compress) {
    return { encoding: "identity", body: html, headers: { "Content-Type": CONTENT_TYPE } };
  }
  const encoding = negotiateAppHtmlEncoding(acceptEncoding);
  if (encoding !== "identity") {
    try {
      const body = await encodeAppHtml(html, encoding);
      return {
        encoding,
        body,
        headers: {
          "Content-Type": CONTENT_TYPE,
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
    headers: { "Content-Type": CONTENT_TYPE, Vary: "Accept-Encoding" },
  };
}

/** Fetch-API flavor for the Bun servers. */
export async function appHtmlResponse(req: Request, html: string, compress: boolean): Promise<Response> {
  const prepared = await prepareAppHtml(html, req.headers.get("accept-encoding"), compress);
  // A Buffer is a valid fetch body in both runtimes; the lib types lag.
  return new Response(prepared.body as BodyInit, { headers: prepared.headers });
}
