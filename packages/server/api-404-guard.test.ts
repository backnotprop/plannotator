import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";
let archivePath = "";

interface RunningServer {
  readonly url: string;
  stop(): void;
}

interface ServerCase {
  readonly name: string;
  readonly knownApiPath: string;
  readonly additionalUnknownApiPaths?: readonly string[];
  readonly start: () => Promise<RunningServer>;
}

const serverCases = [
  {
    name: "Bun plan",
    knownApiPath: "/api/plan",
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
    additionalUnknownApiPaths: ["/api/ai/nonexistent-route"],
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
    additionalUnknownApiPaths: ["/api/ai/nonexistent-route"],
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
        for (const path of serverCase.additionalUnknownApiPaths ?? []) {
          await expectJsonNotFound(server, path);
        }

        const knownApiResponse = await fetch(
          `${server.url}${serverCase.knownApiPath}`,
        );
        expect(knownApiResponse.status).toBe(200);
        expect(knownApiResponse.headers.get("content-type")).toContain(
          "application/json",
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
});
