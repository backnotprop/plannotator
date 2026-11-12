/**
 * Compression of the Inbox's JSON answers for the browser, on every listener
 * the browser reaches: the window's own loopback port (and so a plain reverse
 * proxy or ssh tunnel in front of it) and the Inbox's tailnet listener. One
 * path for both, applied where each listener answers, so no listener can drift.
 *
 * Not applied inside the handler the device door and the relay call in
 * process: the door forwards no `Accept-Encoding`, and the relay reads bodies
 * as text, so an encoded body there would break it.
 *
 * The window's list and thread reads are the big ones (a 300-thread list is
 * ~230 KB, a 50-message thread ~240 KB) and compress 4-8x. The page and its
 * scripts are compressed by the shared app helper (`prepareAppHtml`,
 * `packedAppResponse`), not here.
 *
 * Left exactly as they are (the same Response object, never read):
 * - anything that is not `application/json` (the event stream, pictures,
 *   video, attachments, the page, scripts);
 * - a body already encoded, a HEAD, and any status other than 200;
 * - any answer with a byte range or a validator of its own (`Content-Range`,
 *   `Accept-Ranges`, `ETag`, `Content-Disposition`): a file a person attached,
 *   which may be a `.json`, keeps its identity bytes so ranges and ETags hold;
 * - a client that takes neither br nor gzip.
 * Bodies under `INBOX_JSON_COMPRESS_MIN_BYTES` go out as they are, with
 * `Vary` only. Bun-only: the Inbox has no Pi twin.
 */
import * as zlib from "node:zlib";
import { negotiateAppHtmlEncoding } from "@plannotator/shared/app-html";

/** Below this a compressed body saves less than a packet. */
export const INBOX_JSON_COMPRESS_MIN_BYTES = 1024;

/**
 * Brotli quality 4: about as fast as gzip 6 on a 230 KB list (a few ms, off
 * the event loop) and smaller. Dynamic answers are compressed per request,
 * so the cheap end of brotli is the right one.
 */
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 6;

const KEEP_AS_IS = ["content-encoding", "content-range", "accept-ranges", "etag", "content-disposition"];

function compress(input: Buffer, encoding: "br" | "gzip"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === "br") {
      zlib.brotliCompress(
        input,
        {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
            [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
          },
        },
        done,
      );
    } else {
      zlib.gzip(input, { level: GZIP_LEVEL }, done);
    }
  });
}

function addVary(headers: Headers): void {
  const vary = headers.get("vary");
  if (!vary) headers.set("Vary", "Accept-Encoding");
  else if (!vary.split(",").some((v) => v.trim().toLowerCase() === "accept-encoding")) headers.set("Vary", `${vary}, Accept-Encoding`);
}

/** The browser-facing answer for `res`: a JSON body compressed when the client takes it, else `res` untouched. */
export async function encodeInboxResponse(req: Request, res: Response): Promise<Response> {
  if (req.method === "HEAD" || res.status !== 200 || !res.body) return res;
  const type = res.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return res;
  if (KEEP_AS_IS.some((name) => res.headers.has(name))) return res;
  const encoding = negotiateAppHtmlEncoding(req.headers.get("accept-encoding"));
  const raw = Buffer.from(await res.arrayBuffer());
  const headers = new Headers(res.headers);
  addVary(headers);
  if (encoding === "identity" || raw.length < INBOX_JSON_COMPRESS_MIN_BYTES) {
    return new Response(raw as BodyInit, { status: res.status, statusText: res.statusText, headers });
  }
  let body: Buffer;
  try {
    body = await compress(raw, encoding);
  } catch {
    return new Response(raw as BodyInit, { status: res.status, statusText: res.statusText, headers });
  }
  headers.set("Content-Encoding", encoding);
  headers.set("Content-Length", String(body.length));
  // A Buffer is a valid fetch body; the lib types lag.
  return new Response(body as BodyInit, { status: res.status, statusText: res.statusText, headers });
}
