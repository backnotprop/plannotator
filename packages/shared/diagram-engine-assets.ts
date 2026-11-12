import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareAppHtml } from "./app-html";

export const DIAGRAM_ENGINE_ROUTE_PREFIX = "/assets/diagram-engine/";

export const DIAGRAM_ENGINE_FILE_NAMES = ["engine", "mermaid", "graphviz"] as const;
export type DiagramEngineFileName = (typeof DIAGRAM_ENGINE_FILE_NAMES)[number];

export type DiagramEngineSources = Record<DiagramEngineFileName, string>;

export type DiagramEngineAdvert = Record<DiagramEngineFileName, string>;

export type DiagramEngineSource =
  | DiagramEngineSources
  | (() => Promise<DiagramEngineSources | null | undefined>)
  | null
  | undefined;

export function diagramEngineSourcesFromDir(dir: string): () => Promise<DiagramEngineSources | null> {
  return async () => {
    try {
      const [engine, mermaid, graphviz] = await Promise.all(
        DIAGRAM_ENGINE_FILE_NAMES.map((name) => readFile(join(dir, `${name}.js`), "utf8")),
      );
      return { engine, mermaid, graphviz };
    } catch {
      return null;
    }
  };
}

function isComplete(sources: DiagramEngineSources | null | undefined): sources is DiagramEngineSources {
  return !!sources && DIAGRAM_ENGINE_FILE_NAMES.every((name) => typeof sources[name] === "string" && sources[name].length > 0);
}

interface Prepared {
  advert: DiagramEngineAdvert;
  files: Map<string, string>;
}

export interface DiagramEngineAssets {
  advert(): Promise<DiagramEngineAdvert | undefined>;
  file(pathname: string): Promise<string | null>;
}

export function createDiagramEngineAssets(source: DiagramEngineSource): DiagramEngineAssets & { warm(): void } {
  let prepared: Promise<Prepared | null> | null = null;
  const prepare = (): Promise<Prepared | null> => {
    prepared ??= (async () => {
      let sources: DiagramEngineSources | null | undefined;
      try {
        sources = typeof source === "function" ? await source() : source;
      } catch {
        sources = null;
      }
      if (!isComplete(sources)) return null;
      const advert = {} as DiagramEngineAdvert;
      const files = new Map<string, string>();
      for (const name of DIAGRAM_ENGINE_FILE_NAMES) {
        const hash = createHash("sha256").update(sources[name]).digest("hex").slice(0, 16);
        const fileName = `${name}-${hash}.js`;
        advert[name] = DIAGRAM_ENGINE_ROUTE_PREFIX + fileName;
        files.set(fileName, sources[name]);
      }
      return { advert, files };
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
      if (!pathname.startsWith(DIAGRAM_ENGINE_ROUTE_PREFIX)) return null;
      const name = pathname.slice(DIAGRAM_ENGINE_ROUTE_PREFIX.length);
      return (await prepare())?.files.get(name) ?? null;
    },
  };
}

export interface DiagramEngineAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}

export function isDiagramEngineRequest(pathname: string): boolean {
  return pathname.startsWith(DIAGRAM_ENGINE_ROUTE_PREFIX);
}

export async function answerDiagramEngineRequest(
  assets: DiagramEngineAssets,
  pathname: string,
  method: string | undefined,
  acceptEncoding: string | null | undefined,
  compress: boolean,
): Promise<DiagramEngineAnswer> {
  const plain = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" };
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...plain, Allow: "GET, HEAD" }, body: "Method not allowed" };
  }
  const body = await assets.file(pathname);
  if (body === null) return { status: 404, headers: plain, body: "Not found" };
  const prepared = await prepareAppHtml(body, acceptEncoding, compress, "text/javascript; charset=utf-8");
  return {
    status: 200,
    headers: {
      ...prepared.headers,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    body: method === "HEAD" ? "" : prepared.body,
  };
}
