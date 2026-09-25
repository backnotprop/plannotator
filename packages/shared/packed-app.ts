import { gzipSync } from "node:zlib";

/**
 * The built apps ship as ONE file per app, which every host embeds or copies
 * as-is (the compiled CLI, the Pi and OpenCode packages). The browser, though,
 * should only download what it runs: the lazy chunks (Shiki grammars, Mermaid,
 * Graphviz, KaTeX) are most of the bytes, and a phone on a tailnet or an SSH
 * tunnel waits for every one of them before the first paint.
 *
 * So the build (`build/pack-app.ts`) keeps Vite's code-split output and packs
 * it behind a marker after the page: the page references its chunks by URL,
 * and the servers answer those URLs from the pack. Text assets are gzipped on
 * first request when the client accepts it; binary ones are already compressed.
 *
 * Layout after the marker: one line of JSON indexing every asset by URL path
 * into the raw asset data that follows it, so neither building nor serving
 * escapes or parses the ~25MB of code.
 */
export const PACKED_ASSETS_MARKER = "<!--plannotator:packed-assets-->";

/** A packed asset: text is served gzipped when accepted, binary rides as base64. */
export type PackedAsset =
  | { type: string; text: string }
  | { type: string; base64: string };

interface PackedEntry {
  type: string;
  start: number;
  end: number;
  base64?: true;
}

export interface PackedAssetResponse {
  body: Buffer;
  headers: Record<string, string>;
}

export interface PackedApp {
  /** The page to serve, without the pack. */
  html: string;
  /** The packed asset at this URL path, or undefined when there is none. */
  asset(pathname: string, acceptEncoding: string | null | undefined): PackedAssetResponse | undefined;
}

/** Asset URLs carry a content hash, so a response never changes. */
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
  if (markerAt < 0) return { html: bundle, asset: () => undefined };

  const indexAt = markerAt + PACKED_ASSETS_MARKER.length;
  const dataAt = bundle.indexOf("\n", indexAt) + 1;
  // Parsed on the first asset request, so a CLI run that never serves the
  // page (or a host that never opens it) pays nothing.
  let index: Map<string, PackedEntry> | undefined;
  const responses = new Map<string, PackedAssetResponse>();
  return {
    html: bundle.slice(0, markerAt),
    asset(pathname, acceptEncoding) {
      index ??= new Map(Object.entries(JSON.parse(bundle.slice(indexAt, dataAt - 1))));
      const entry = index.get(pathname);
      if (!entry) return undefined;
      const gzip = !entry.base64 && /\bgzip\b/.test(acceptEncoding ?? "");
      const key = `${gzip ? "gzip" : "identity"} ${pathname}`;
      if (!responses.has(key)) {
        responses.set(key, toResponse(entry, bundle.slice(dataAt + entry.start, dataAt + entry.end), gzip));
      }
      return responses.get(key);
    },
  };
}

function toResponse(entry: PackedEntry, content: string, gzip: boolean): PackedAssetResponse {
  if (entry.base64) {
    return {
      body: Buffer.from(content, "base64"),
      headers: { "Content-Type": entry.type, "Cache-Control": IMMUTABLE },
    };
  }
  return {
    body: gzip ? gzipSync(content) : Buffer.from(content),
    headers: {
      "Content-Type": entry.type,
      "Cache-Control": IMMUTABLE,
      Vary: "Accept-Encoding",
      ...(gzip ? { "Content-Encoding": "gzip" } : {}),
    },
  };
}
