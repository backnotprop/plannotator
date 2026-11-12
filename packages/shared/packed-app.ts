import { compressAppText, negotiateAppHtmlEncoding, prepareAppHtml } from "./app-html";

export const PACKED_ASSETS_MARKER = "<plaintext hidden><!--plannotator:packed-assets-->";

export const PACKED_ASSET_ROUTE_PREFIX = "/assets/";

export type PackedAsset =
  | { type: string; text: string }
  | { type: string; base64: string };

interface PackedEntry {
  type: string;
  start: number;
  end: number;
  base64?: true;
}

export interface PackedAppAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export interface PackedApp {
  html: string;
  answer(
    pathname: string,
    method: string | undefined,
    acceptEncoding: string | null | undefined,
    compress: boolean,
  ): Promise<PackedAppAnswer>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

export function packApp(html: string, assets: Record<string, PackedAsset>): string {
  const index: Record<string, PackedEntry> = {};
  const data: string[] = [];
  let offset = 0;
  for (const [path, asset] of Object.entries(assets)) {
    const content = "text" in asset ? asset.text : asset.base64;
    index[path] = { type: asset.type, start: offset, end: offset + content.length, ...("base64" in asset ? { base64: true } : {}) };
    data.push(content);
    offset += content.length;
  }
  return `${html}${PACKED_ASSETS_MARKER}${JSON.stringify(index)}\n${data.join("")}`;
}

export function openPackedApp(bundle: string): PackedApp {
  const markerAt = bundle.indexOf(PACKED_ASSETS_MARKER);
  const html = markerAt < 0 ? bundle : bundle.slice(0, markerAt);
  const indexAt = markerAt + PACKED_ASSETS_MARKER.length;
  const dataAt = markerAt < 0 ? -1 : bundle.indexOf("\n", indexAt) + 1;
  let index: Map<string, PackedEntry> | undefined;
  const lookup = (pathname: string): PackedEntry | undefined => {
    if (markerAt < 0) return undefined;
    index ??= new Map(Object.entries(JSON.parse(bundle.slice(indexAt, dataAt - 1)) as Record<string, PackedEntry>));
    return index.get(pathname);
  };
  const bodies = new Map<string, Promise<Buffer>>();
  const body = (pathname: string, entry: PackedEntry, encoding: "br" | "gzip" | "identity"): Promise<Buffer> => {
    const key = `${encoding} ${pathname}`;
    let pending = bodies.get(key);
    if (!pending) {
      const content = bundle.slice(dataAt + entry.start, dataAt + entry.end);
      pending = entry.base64
        ? Promise.resolve(Buffer.from(content, "base64"))
        : encoding === "identity"
          ? Promise.resolve(Buffer.from(content, "utf8"))
          : compressAppText(content, encoding);
      bodies.set(key, pending);
      pending.catch(() => bodies.delete(key));
    }
    return pending;
  };

  return {
    html,
    async answer(pathname, method, acceptEncoding, compress) {
      if (!pathname.startsWith(PACKED_ASSET_ROUTE_PREFIX)) {
        const page = await prepareAppHtml(html, acceptEncoding, compress);
        return { status: 200, headers: page.headers, body: page.body };
      }
      const plain = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" };
      if (method !== "GET" && method !== "HEAD") {
        return { status: 405, headers: { ...plain, Allow: "GET, HEAD" }, body: "Method not allowed" };
      }
      const entry = lookup(pathname);
      if (!entry) return { status: 404, headers: plain, body: "Not found" };

      const headers: Record<string, string> = {
        "Content-Type": entry.type,
        "Cache-Control": IMMUTABLE,
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
      };
      const text = !entry.base64;
      if (compress && text) headers.Vary = "Accept-Encoding";
      let encoding = compress && text ? negotiateAppHtmlEncoding(acceptEncoding) : "identity";
      let bytes: Buffer;
      try {
        bytes = await body(pathname, entry, encoding);
      } catch (err) {
        console.error("[plannotator] App chunk compression failed; serving uncompressed:", err);
        encoding = "identity";
        bytes = await body(pathname, entry, encoding);
      }
      if (encoding !== "identity") headers["Content-Encoding"] = encoding;
      headers["Content-Length"] = String(bytes.length);
      return { status: 200, headers, body: bytes };
    },
  };
}

export async function packedAppResponse(app: PackedApp, req: Request, pathname: string, compress: boolean): Promise<Response> {
  const answer = await app.answer(pathname, req.method, req.headers.get("accept-encoding"), compress);
  return new Response(answer.body as BodyInit, { status: answer.status, headers: answer.headers });
}
