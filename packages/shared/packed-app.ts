import { compressAppText, negotiateAppHtmlEncoding, prepareAppHtml } from "./app-html";

/**
 * The built apps ship as ONE file per app, which every host embeds or copies
 * as-is (the compiled CLI, the Pi and OpenCode packages). The browser, though,
 * should only download what it runs: the lazy chunks (Shiki grammars, Mermaid,
 * Graphviz, KaTeX, fonts) are most of the bytes, and a phone on a tailnet or an
 * SSH tunnel waits for every one of them before the first paint.
 *
 * So the build (`build/pack-app.ts`) keeps Vite's code-split output and packs
 * it behind a marker after the page: the page references its chunks by URL,
 * and the servers answer those URLs from the pack (`answer`), by exact name,
 * from memory only. Remote and `--tailscale` sessions get text chunks
 * compressed by the page's own rule (./app-html); binary ones are already
 * compressed.
 *
 * Layout after the marker: one line of JSON indexing every asset by URL path
 * into the raw asset data that follows it, so neither building nor serving
 * escapes or parses the ~25MB of code.
 */
//
// The marker opens a hidden <plaintext>, which has no end tag: a server
// older than the pack (a Pi session that read the file after an in-place
// update) serves the whole file as the page, and the browser then takes
// everything after the marker as hidden text instead of rendering the index
// and the chunks. The page itself says what happened (build/pack-app.ts).
export const PACKED_ASSETS_MARKER = "<plaintext hidden><!--plannotator:packed-assets-->";

/** Every packed asset lives here (Vite's `assetsDir`); the build refuses any other path. */
export const PACKED_ASSET_ROUTE_PREFIX = "/assets/";

/** A packed asset: text is served as-is or compressed, binary rides as base64. */
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
  /** The page to serve, without the pack. */
  html: string;
  /**
   * The answer to a request no other route claimed: under `/assets/` the
   * packed file of exactly that name (404 when there is none, 405 for anything
   * but GET and HEAD), else the page (SPA). `compress` is the page's own rule
   * (remote and `--tailscale` sessions).
   */
  answer(
    pathname: string,
    method: string | undefined,
    acceptEncoding: string | null | undefined,
    compress: boolean,
  ): Promise<PackedAppAnswer>;
}

/** Asset URLs carry Vite's content hash, so a response never changes. */
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

/** Split a built app into its page and assets. An unpacked page serves as-is. */
export function openPackedApp(bundle: string): PackedApp {
  const markerAt = bundle.indexOf(PACKED_ASSETS_MARKER);
  const html = markerAt < 0 ? bundle : bundle.slice(0, markerAt);
  const indexAt = markerAt + PACKED_ASSETS_MARKER.length;
  const dataAt = markerAt < 0 ? -1 : bundle.indexOf("\n", indexAt) + 1;
  // Parsed on the first asset request, so a CLI run that never serves the
  // page (or a host that never opens it) pays nothing.
  let index: Map<string, PackedEntry> | undefined;
  const lookup = (pathname: string): PackedEntry | undefined => {
    if (markerAt < 0) return undefined;
    index ??= new Map(Object.entries(JSON.parse(bundle.slice(indexAt, dataAt - 1)) as Record<string, PackedEntry>));
    return index.get(pathname);
  };
  // One body per (encoding, asset), made on first request and kept for the
  // session: a page load asks for the same few dozen files every time.
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

/** Fetch-API flavor for the Bun servers. */
export async function packedAppResponse(app: PackedApp, req: Request, pathname: string, compress: boolean): Promise<Response> {
  const answer = await app.answer(pathname, req.method, req.headers.get("accept-encoding"), compress);
  // A Buffer is a valid fetch body in both runtimes; the lib types lag.
  return new Response(answer.body as BodyInit, { status: answer.status, headers: answer.headers });
}
