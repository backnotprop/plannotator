import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAVICON_PNG_BYTES } from "../core/favicon";
// Use a distinct module key so unrelated mock.module() tests cannot replace
// the real server.
import { startAnnotateServer as startBunAnnotateServer } from "./annotate.ts?api-404-guard";
import { startPlannotatorServer as startBunPlanServer } from "./index";
import { startReviewServer as startBunReviewServer } from "./review";
import {
  startAnnotateServer as startPiAnnotateServer,
  startPlanReviewServer as startPiPlanServer,
  startReviewServer as startPiReviewServer,
} from "../../apps/pi-extension/server";
import {
  handlePiAIRequest,
  type PiAIRuntime,
} from "../../apps/pi-extension/server/ai-runtime";

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";
const AI_ENDPOINTS_REQUIRING_BACKEND = [
  "/api/ai/session",
  "/api/ai/query",
  "/api/ai/abort",
  "/api/ai/permission",
  "/api/ai/sessions",
] as const;
let archivePath = "";

interface RunningServer {
  readonly url: string;
  stop(): void;
}

interface ServerCase {
  readonly name: string;
  readonly knownApiPath: string;
  readonly knownAIBackendUnavailable?: boolean;
  readonly start: () => Promise<RunningServer>;
}

const serverCases = [
  {
    name: "Bun plan",
    knownApiPath: "/api/plan",
    knownAIBackendUnavailable: true,
    start: () =>
      startBunPlanServer({
        plan: "# Test Plan",
        origin: "claude-code",
        htmlContent: SPA_HTML,
        mode: "archive",
        customPlanPath: archivePath,
      }),
  },
  {
    name: "Bun review",
    knownApiPath: "/api/diff",
    start: () =>
      startBunReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
  },
  {
    name: "Bun annotate",
    knownApiPath: "/api/plan",
    start: () =>
      startBunAnnotateServer({
        markdown: "# Test Document",
        filePath: "test.md",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
  },
  {
    name: "Pi plan",
    knownApiPath: "/api/plan",
    knownAIBackendUnavailable: true,
    start: () =>
      startPiPlanServer({
        plan: "# Test Plan",
        origin: "pi",
        htmlContent: SPA_HTML,
        mode: "archive",
        customPlanPath: archivePath,
      }),
  },
  {
    name: "Pi review",
    knownApiPath: "/api/diff",
    start: () =>
      startPiReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
  },
  {
    name: "Pi annotate",
    knownApiPath: "/api/plan",
    start: () =>
      startPiAnnotateServer({
        markdown: "# Test Document",
        filePath: "test.md",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
  },
] satisfies readonly ServerCase[];

async function expectJsonNotFound(
  server: RunningServer,
  requestPath: string,
): Promise<void> {
  const response = await fetch(`${server.url}${requestPath}`);
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({
    error: "Not found",
    path: new URL(requestPath, server.url).pathname,
  });
}

async function expectKnownAICapabilities(server: RunningServer): Promise<void> {
  const response = await fetch(`${server.url}/api/ai/capabilities`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");

  const body = await response.json() as {
    available?: unknown;
    providers?: unknown;
  };
  expect(typeof body.available).toBe("boolean");
  expect(Array.isArray(body.providers)).toBe(true);
}

async function expectKnownAIBackendUnavailable(server: RunningServer): Promise<void> {
  for (const endpoint of AI_ENDPOINTS_REQUIRING_BACKEND) {
    const response = await fetch(`${server.url}${endpoint}`);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "AI backend not available" });
  }
}

async function startOnRandomLocalPort(
  start: () => Promise<RunningServer>,
): Promise<RunningServer> {
  const previousPort = process.env.PLANNOTATOR_PORT;
  const previousRemote = process.env.PLANNOTATOR_REMOTE;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";

  try {
    return await start();
  } finally {
    if (previousPort === undefined) {
      delete process.env.PLANNOTATOR_PORT;
    } else {
      process.env.PLANNOTATOR_PORT = previousPort;
    }
    if (previousRemote === undefined) {
      delete process.env.PLANNOTATOR_REMOTE;
    } else {
      process.env.PLANNOTATOR_REMOTE = previousRemote;
    }
  }
}

describe("API route 404 guards", () => {
  beforeAll(() => {
    archivePath = mkdtempSync(join(tmpdir(), "plannotator-api-404-"));
  });

  afterAll(() => {
    rmSync(archivePath, { recursive: true, force: true });
  });

  for (const serverCase of serverCases) {
    test(`${serverCase.name} returns JSON 404 without breaking API or SPA routes`, async () => {
      const server = await startOnRandomLocalPort(serverCase.start);

      try {
        expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
        await expectJsonNotFound(
          server,
          "/api/nonexistent-route?ignored=query",
        );
        await expectJsonNotFound(server, "/api/ai/nonexistent-route");

        const knownApiResponse = await fetch(
          `${server.url}${serverCase.knownApiPath}`,
        );
        expect(knownApiResponse.status).toBe(200);
        expect(knownApiResponse.headers.get("content-type")).toContain(
          "application/json",
        );

        await expectKnownAICapabilities(server);
        if (serverCase.knownAIBackendUnavailable) {
          await expectKnownAIBackendUnavailable(server);
        }

        const faviconResponse = await fetch(`${server.url}/favicon.png`);
        expect(faviconResponse.status).toBe(200);
        expect(faviconResponse.headers.get("content-type")).toBe("image/png");
        expect(faviconResponse.headers.get("cache-control")).toBe(
          "public, max-age=86400",
        );
        expect(new Uint8Array(await faviconResponse.arrayBuffer())).toEqual(
          FAVICON_PNG_BYTES,
        );

        const spaResponse = await fetch(`${server.url}/some/random/path`);
        expect(spaResponse.status).toBe(200);
        expect(spaResponse.headers.get("content-type")).toContain("text/html");
        expect(await spaResponse.text()).toBe(SPA_HTML);
      } finally {
        server.stop();
      }
    });
  }

  test("Pi serves a live runtime handler before unavailable-route classification", async () => {
    const futurePath = "/api/ai/future-route";
    const runtime: PiAIRuntime = {
      endpoints: {
        [futurePath]: async () => Response.json({ served: futurePath }),
      },
      dispose: () => {},
    };
    const nodeServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      void handlePiAIRequest(req, res, url, runtime);
    });

    await new Promise<void>((resolve, reject) => {
      nodeServer.once("error", reject);
      nodeServer.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = nodeServer.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral TCP address");
      }
      const response = await fetch(`http://127.0.0.1:${address.port}${futurePath}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ served: futurePath });
    } finally {
      await new Promise<void>((resolve, reject) => {
        nodeServer.close(error => error ? reject(error) : resolve());
      });
    }
  });
});
