import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { negotiateAppHtmlEncoding } from "./app-html";

export const SEM_DIFF_ROUTE_PREFIX = "/assets/sem-diff/";

export const SEM_DIFF_RUNTIME_FILE = "web-tree-sitter.wasm";

export const SEM_DIFF_GRAMMAR_FILES = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
] as const;

export const SEM_DIFF_FILES = [SEM_DIFF_RUNTIME_FILE, ...SEM_DIFF_GRAMMAR_FILES] as const;
export type SemDiffFileName = (typeof SEM_DIFF_FILES)[number];

export type SemDiffSources = Record<SemDiffFileName, Uint8Array>;

export interface SemDiffAdvert {
  runtime: string;
  grammars: Partial<Record<string, string>>;
}

export type SemDiffSource =
  | SemDiffSources
  | (() => Promise<SemDiffSources | null | undefined>)
  | null
  | undefined;

export function semDiffSourcesFromDir(dir: string): () => Promise<SemDiffSources | null> {
  return async () => {
    try {
      const bytes = await Promise.all(SEM_DIFF_FILES.map((name) => readFile(join(dir, name))));
      return Object.fromEntries(SEM_DIFF_FILES.map((name, i) => [name, new Uint8Array(bytes[i]!)])) as SemDiffSources;
    } catch {
      return null;
    }
  };
}

function isComplete(sources: SemDiffSources | null | undefined): sources is SemDiffSources {
  return !!sources && SEM_DIFF_FILES.every((name) => sources[name] instanceof Uint8Array && sources[name].byteLength > 0);
}

interface Prepared {
  advert: SemDiffAdvert;
  files: Map<string, Uint8Array>;
}

export interface SemDiffAssets {
  advert(): Promise<SemDiffAdvert | undefined>;
  file(pathname: string): Promise<Uint8Array | null>;
  warm(): void;
}

export function createSemDiffAssets(source: SemDiffSource): SemDiffAssets {
  let prepared: Promise<Prepared | null> | null = null;
  const prepare = (): Promise<Prepared | null> => {
    prepared ??= (async () => {
      let sources: SemDiffSources | null | undefined;
      try {
        sources = typeof source === "function" ? await source() : source;
      } catch {
        sources = null;
      }
      if (!isComplete(sources)) return null;
      const files = new Map<string, Uint8Array>();
      const served = {} as Record<SemDiffFileName, string>;
      for (const name of SEM_DIFF_FILES) {
        const hash = createHash("sha256").update(sources[name]).digest("hex").slice(0, 16);
        const fileName = `${name.slice(0, -".wasm".length)}-${hash}.wasm`;
        served[name] = SEM_DIFF_ROUTE_PREFIX + fileName;
        files.set(fileName, sources[name]);
      }
      const grammars: Partial<Record<string, string>> = {};
      for (const name of SEM_DIFF_GRAMMAR_FILES) grammars[name] = served[name];
      return { advert: { runtime: served[SEM_DIFF_RUNTIME_FILE], grammars }, files };
    })();
    return prepared;
  };
  return {
    warm() {
      void prepare();
    },
    async advert() {
      return (await prepare())?.advert;
    },
    async file(pathname) {
      if (!pathname.startsWith(SEM_DIFF_ROUTE_PREFIX)) return null;
      return (await prepare())?.files.get(pathname.slice(SEM_DIFF_ROUTE_PREFIX.length)) ?? null;
    },
  };
}

export function isSemDiffRequest(pathname: string): boolean {
  return pathname.startsWith(SEM_DIFF_ROUTE_PREFIX);
}

export interface SemDiffAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

const encoded = new WeakMap<Uint8Array, Partial<Record<"br" | "gzip", Promise<Uint8Array>>>>();
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

function encode(body: Uint8Array, encoding: "br" | "gzip"): Promise<Uint8Array> {
  let entry = encoded.get(body);
  if (!entry) {
    entry = {};
    encoded.set(body, entry);
  }
  const owner = entry;
  let pending = owner[encoding];
  if (!pending) {
    pending = (encoding === "br"
      ? brotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipAsync(body, { level: 9 })
    ).then((b) => new Uint8Array(b));
    owner[encoding] = pending;
    pending.catch(() => {
      if (owner[encoding] === pending) delete owner[encoding];
    });
  }
  return pending;
}

export async function answerSemDiffRequest(
  assets: SemDiffAssets,
  pathname: string,
  method: string | undefined,
  acceptEncoding: string | null | undefined,
  compress: boolean,
): Promise<SemDiffAnswer> {
  const plain = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" };
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...plain, Allow: "GET, HEAD" }, body: "Method not allowed" };
  }
  const file = await assets.file(pathname);
  if (file === null) return { status: 404, headers: plain, body: "Not found" };
  const headers: Record<string, string> = {
    "Content-Type": "application/wasm",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  let body = file;
  if (compress) {
    headers.Vary = "Accept-Encoding";
    const encoding = negotiateAppHtmlEncoding(acceptEncoding);
    if (encoding !== "identity") {
      try {
        body = await encode(file, encoding);
        headers["Content-Encoding"] = encoding;
      } catch (err) {
        console.error("[plannotator] Semantic diff asset compression failed; serving uncompressed:", err);
      }
    }
  }
  headers["Content-Length"] = String(body.byteLength);
  return { status: 200, headers, body: method === "HEAD" ? "" : body };
}
