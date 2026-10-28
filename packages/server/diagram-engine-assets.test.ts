/**
 * Code review's diagram engine, served on demand (owner approval
 * "review-diagrams-on-demand"), on BOTH review servers (Bun and the Pi
 * mirror) so the two cannot drift.
 *
 * Regressions guarded:
 *  - the `/api/diff` advert missing, or naming a file the route does not
 *    serve;
 *  - a served file without its JavaScript type, immutable caching, nosniff
 *    or same-origin resource policy (a module script needs the type; the
 *    hash in the name is what makes immutable safe);
 *  - a guessed or stale name answered with the app page (the SPA catch-all)
 *    instead of a 404, or a non-GET answered at all;
 *  - a host without the files advertising an engine (the page would then
 *    try to import a file that is not there instead of showing code);
 *  - remote sessions getting the ~8 MB files uncompressed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  DIAGRAM_ENGINE_ROUTE_PREFIX,
  answerDiagramEngineRequest,
  createDiagramEngineAssets,
  diagramEngineSourcesFromDir,
  type DiagramEngineSources,
} from "@plannotator/shared/diagram-engine-assets";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import { rawRequest } from "../../tests/helpers/app-html";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const environment = createTestEnvironment(
  ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER"],
  "plannotator-diagram-engine-",
);

afterEach(() => environment.restore());

async function isolate(remote = false): Promise<void> {
  environment.reset();
  process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
  process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
  process.env.PLANNOTATOR_REMOTE = remote ? "1" : "0";
  const { start, servers } = await occupyConsecutivePorts(1);
  await closeServer(servers[0]);
  process.env.PLANNOTATOR_PORT = String(start);
}

const HTML = "<!doctype html><title>review</title>";
const PATCH = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n-old\n+new\n";
const SOURCES: DiagramEngineSources = {
  engine: "export const apiVersion = 1; export function DiagramFence() { return null; } // é",
  mermaid: `export default { name: "mermaid" }; // ${"m".repeat(4096)}`,
  graphviz: 'export function instance() { return Promise.resolve({}); } // ✓',
};

describe("createDiagramEngineAssets", () => {
  test("names each file by its content hash under the route", async () => {
    const assets = createDiagramEngineAssets(SOURCES);
    const advert = (await assets.advert())!;
    for (const name of ["engine", "mermaid", "graphviz"] as const) {
      expect(advert[name]).toMatch(new RegExp(`^${DIAGRAM_ENGINE_ROUTE_PREFIX}${name}-[0-9a-f]{16}\\.js$`));
      expect(await assets.file(advert[name])).toBe(SOURCES[name]);
    }
    // Another body, another name: a cached file never outlives its contents.
    const changed = await createDiagramEngineAssets({ ...SOURCES, engine: `${SOURCES.engine} ` }).advert();
    expect(changed!.engine).not.toBe(advert.engine);
    expect(changed!.mermaid).toBe(advert.mermaid);
  });

  test("a host without complete files advertises nothing and serves nothing", async () => {
    for (const source of [undefined, null, { ...SOURCES, graphviz: "" }, async () => null, async () => { throw new Error("gone"); }]) {
      const assets = createDiagramEngineAssets(source as never);
      expect(await assets.advert()).toBeUndefined();
      expect(await assets.file(`${DIAGRAM_ENGINE_ROUTE_PREFIX}engine-0000000000000000.js`)).toBeNull();
    }
  });

  test("reads the three files from a folder, and nothing when one is missing", async () => {
    environment.reset();
    const dir = environment.makeTempDir();
    for (const [name, body] of Object.entries(SOURCES)) writeFileSync(join(dir, `${name}.js`), body);
    expect(await diagramEngineSourcesFromDir(dir)()).toEqual(SOURCES);
    const partial = join(dir, "partial");
    mkdirSync(partial);
    writeFileSync(join(partial, "engine.js"), SOURCES.engine);
    expect(await diagramEngineSourcesFromDir(partial)()).toBeNull();
  });

  test("answers: 200 with the module headers, HEAD empty, unknown 404, other methods 405", async () => {
    const assets = createDiagramEngineAssets(SOURCES);
    const advert = (await assets.advert())!;
    const ok = await answerDiagramEngineRequest(assets, advert.engine, "GET", null, false);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe(SOURCES.engine);
    expect(ok.headers).toMatchObject({
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    expect((await answerDiagramEngineRequest(assets, advert.engine, "HEAD", null, false)).body).toBe("");
    expect((await answerDiagramEngineRequest(assets, `${DIAGRAM_ENGINE_ROUTE_PREFIX}engine.js`, "GET", null, false)).status).toBe(404);
    expect((await answerDiagramEngineRequest(assets, `${DIAGRAM_ENGINE_ROUTE_PREFIX}../review.html`, "GET", null, false)).status).toBe(404);
    expect((await answerDiagramEngineRequest(assets, advert.engine, "POST", null, false)).status).toBe(405);
    const gz = await answerDiagramEngineRequest(assets, advert.mermaid, "GET", "gzip", true);
    expect(gz.headers["Content-Encoding"]).toBe("gzip");
    expect(gunzipSync(gz.body as Buffer).toString("utf8")).toBe(SOURCES.mermaid);
  });
});

type Start = (options: { rawPatch: string; gitRef: string; htmlContent: string; diagramEngine?: unknown }) => Promise<{ url: string; stop: () => unknown }>;
const RUNTIMES: Array<[string, Start]> = [
  ["Bun", startBunReviewServer as unknown as Start],
  ["Pi", startPiReviewServer as unknown as Start],
];

for (const [runtime, start] of RUNTIMES) {
  describe(`${runtime} review server`, () => {
    test("advertises the engine on /api/diff and serves exactly the advertised files", async () => {
      await isolate();
      const server = await start({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: HTML, diagramEngine: async () => SOURCES });
      try {
        const diff = (await (await fetch(`${server.url}/api/diff`)).json()) as { diagramEngine?: Record<string, string> };
        expect(Object.keys(diff.diagramEngine ?? {}).sort()).toEqual(["engine", "graphviz", "mermaid"]);
        for (const name of ["engine", "mermaid", "graphviz"] as const) {
          const res = await rawRequest(`${server.url}${diff.diagramEngine![name]}`);
          expect(res.status).toBe(200);
          expect(res.body.toString("utf8")).toBe(SOURCES[name]);
          expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
          expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
          expect(res.headers["x-content-type-options"]).toBe("nosniff");
          expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
          expect(res.headers["content-encoding"]).toBeUndefined();
        }
        // A guessed name is a 404, never the app page.
        const guessed = await rawRequest(`${server.url}${DIAGRAM_ENGINE_ROUTE_PREFIX}engine.js`);
        expect(guessed.status).toBe(404);
        expect(guessed.body.toString("utf8")).not.toContain("<title>review</title>");
        expect((await rawRequest(`${server.url}${diff.diagramEngine!.engine}`, { method: "DELETE" })).status).toBe(405);
      } finally {
        await server.stop();
      }
    });

    test("without the files: no advert, and the route answers 404", async () => {
      await isolate();
      const server = await start({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: HTML });
      try {
        const diff = (await (await fetch(`${server.url}/api/diff`)).json()) as { diagramEngine?: unknown };
        expect(diff.diagramEngine).toBeUndefined();
        const res = await rawRequest(`${server.url}${DIAGRAM_ENGINE_ROUTE_PREFIX}engine-0000000000000000.js`);
        expect(res.status).toBe(404);
        // The app page itself is unchanged.
        expect((await rawRequest(`${server.url}/`)).body.toString("utf8")).toBe(HTML);
      } finally {
        await server.stop();
      }
    });

    test("remote sessions get the files compressed, as the app page", async () => {
      await isolate(true);
      const server = await start({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: HTML, diagramEngine: SOURCES });
      try {
        const diff = (await (await fetch(`${server.url}/api/diff`)).json()) as { diagramEngine: Record<string, string> };
        const res = await rawRequest(`${server.url}${diff.diagramEngine.mermaid}`, { headers: { "accept-encoding": "gzip" } });
        expect(res.status).toBe(200);
        expect(res.headers["content-encoding"]).toBe("gzip");
        expect(gunzipSync(res.body).toString("utf8")).toBe(SOURCES.mermaid);
      } finally {
        await server.stop();
      }
    });
  });
}
