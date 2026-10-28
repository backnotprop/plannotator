/**
 * Serving code review's diagram engine (owner approval
 * "review-diagrams-on-demand").
 *
 * The review page draws Mermaid and Graphviz fences with an engine it never
 * carries: three files built beside the single-file page
 * (apps/review/diagram-engine): `engine.js` (the React layer), `mermaid.js`
 * and `graphviz.js` (the runtimes, ~6.6 MB and ~1.3 MB). A review server that
 * has them answers:
 *
 * - `/api/diff` with `diagramEngine: { engine, mermaid, graphviz }`, each a
 *   path under `/assets/diagram-engine/` named by the file's content hash;
 * - `GET /assets/diagram-engine/<name>-<hash>.js` with the file, as
 *   `text/javascript`, `Cache-Control: immutable`, `nosniff` and
 *   `Cross-Origin-Resource-Policy: same-origin`; any other name under the
 *   prefix is 404, anything but GET or HEAD 405.
 *
 * The page imports the engine only when a preview or guide overview holds a
 * diagram fence, so a review without diagrams never asks for any of them. A
 * server without the files (an older host, a source checkout that never ran
 * the review build) advertises nothing, and fences show as code.
 *
 * Shared by the Bun review server and Pi's node:http one (vendored by
 * apps/pi-extension/vendor.sh). Remote and `--tailscale` sessions get the
 * files compressed exactly as the app page (./app-html).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareAppHtml } from "./app-html";

export const DIAGRAM_ENGINE_ROUTE_PREFIX = "/assets/diagram-engine/";

export const DIAGRAM_ENGINE_FILE_NAMES = ["engine", "mermaid", "graphviz"] as const;
export type DiagramEngineFileName = (typeof DIAGRAM_ENGINE_FILE_NAMES)[number];

/** The three built files' text. */
export type DiagramEngineSources = Record<DiagramEngineFileName, string>;

/** `/api/diff`'s `diagramEngine`: where each file is served. */
export type DiagramEngineAdvert = Record<DiagramEngineFileName, string>;

/** A host's way to get the files: given, or read on first need. */
export type DiagramEngineSource =
  | DiagramEngineSources
  | (() => Promise<DiagramEngineSources | null | undefined>)
  | null
  | undefined;

/** Read `<dir>/{engine,mermaid,graphviz}.js`; null when any is missing or empty. */
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
  /** The advert, or undefined when this host has no engine. */
  advert(): Promise<DiagramEngineAdvert | undefined>;
  /** The body served at `pathname`, or null. */
  file(pathname: string): Promise<string | null>;
}

/**
 * The engine files of one server, hashed once on first need (a few ms for
 * ~8 MB). `warm()` the result at server start so `/api/diff` never waits.
 */
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
  /** Empty for HEAD and errors' bodies are short text. */
  body: string | Buffer;
}

/** True when the request is for the engine's route (the caller answers it with `answerDiagramEngineRequest`). */
export function isDiagramEngineRequest(pathname: string): boolean {
  return pathname.startsWith(DIAGRAM_ENGINE_ROUTE_PREFIX);
}

/**
 * The answer to a request under the engine's route. `compress` is the app
 * page's own rule (remote and `--tailscale` sessions).
 */
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
