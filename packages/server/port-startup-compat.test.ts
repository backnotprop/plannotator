import { afterEach, describe, expect, test } from "bun:test";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import { normalizeGoalSetupBundle } from "@plannotator/shared/goal-setup";
import {
  dismissPresentation,
  trackPresentation,
} from "@plannotator/shared/presenter";
import { startAnnotateServer } from "./annotate";
import { startGoalSetupServer } from "./goal-setup";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";
import { handleServerReady } from "./shared-handlers";

const envKeys = [
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_SKIP_BROWSER_OPEN",
  "PLANNOTATOR_AI",
  "__CFBundleIdentifier",
] as const;
const environment = createTestEnvironment(envKeys, "plannotator-port-compat-");

afterEach(() => environment.restore());

describe("Bun startup port compatibility", () => {
  test("unset local startup keeps its random URL and browser-ready handoff", async () => {
    environment.reset();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    process.env.__CFBundleIdentifier = "com.apple.Terminal";
    let ready: { url: string; isRemote: boolean; port: number } | undefined;

    const server = await startPlannotatorServer({
      plan: "# Port compatibility",
      origin: "codex",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      onReady: (url, isRemote, port) => {
        ready = { url, isRemote, port };
      },
    });

    try {
      expect(server.port).toBeGreaterThan(0);
      expect(server.url).toBe(`http://localhost:${server.port}`);
      expect(ready).toEqual({
        url: server.url,
        isRemote: false,
        port: server.port,
      });

      let openedUrl: string | undefined;
      await handleServerReady(server.url, server.isRemote, server.port, {
        openBrowser: async (url) => {
          openedUrl = url;
          return true;
        },
      });
      expect(openedUrl).toBe(server.url);
    } finally {
      await server.stop();
    }
  });

  test("a fixed numeric port keeps the same ready URL", async () => {
    environment.reset();
    const { start, servers } = await occupyConsecutivePorts(1);
    await closeServer(servers[0]);
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_PORT = String(start);
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    let ready: { url: string; isRemote: boolean; port: number } | undefined;

    const server = await startPlannotatorServer({
      plan: "# Fixed port compatibility",
      origin: "codex",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      onReady: (url, isRemote, port) => {
        ready = { url, isRemote, port };
      },
    });

    try {
      expect(server.port).toBe(start);
      expect(server.url).toBe(`http://localhost:${start}`);
      expect(ready).toEqual({ url: server.url, isRemote: false, port: start });
    } finally {
      await server.stop();
    }
  });

  test("server stop dismisses the presentation it owns", async () => {
    environment.reset();
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    let dismissed = 0;

    const server = await startPlannotatorServer({
      plan: "# Presenter lifecycle",
      origin: "codex",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      onReady: (url, isRemote, port) =>
        handleServerReady(url, isRemote, port, {
          presentUrl: async () => ({
            attempted: true,
            opened: true,
            presentation: {
              handle: { paneId: "pane-lifecycle" },
              dismiss: async () => {
                dismissed += 1;
                return { ok: true };
              },
            },
          }),
        }),
    });

    await server.stop();
    await server.stop();
    expect(dismissed).toBe(1);
  });

  test("server stop cannot dismiss a newer presentation after its URL is reused", async () => {
    environment.reset();
    const { start, servers } = await occupyConsecutivePorts(1);
    await closeServer(servers[0]);
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_PORT = String(start);
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    let firstDismissed = 0;
    let replacementDismissed = 0;

    const server = await startPlannotatorServer({
      plan: "# Exact presenter ownership",
      origin: "codex",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      onReady: (url, isRemote, port) =>
        handleServerReady(url, isRemote, port, {
          presentUrl: async () => ({
            attempted: true,
            opened: true,
            presentation: {
              handle: { paneId: "pane-first" },
              dismiss: async () => {
                firstDismissed += 1;
                return { ok: true };
              },
            },
          }),
        }),
    });

    const stopping = server.stop();
    const replacementServer = Bun.serve({
      hostname: "127.0.0.1",
      port: start,
      fetch: () => new Response("replacement"),
    });
    trackPresentation(server.url, {
      handle: { paneId: "pane-replacement" },
      dismiss: async () => {
        replacementDismissed += 1;
        return { ok: true };
      },
    });

    try {
      await stopping;
      expect(firstDismissed).toBe(1);
      expect(replacementDismissed).toBe(0);

      await dismissPresentation(server.url);
      expect(replacementDismissed).toBe(1);
    } finally {
      await dismissPresentation(server.url);
      await replacementServer.stop(true);
    }
  });

  test("an async ready failure releases the fixed port before startup rejects", async () => {
    environment.reset();
    const { start, servers } = await occupyConsecutivePorts(1);
    await closeServer(servers[0]);
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_PORT = String(start);
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    const readyError = new Error("ready handoff failed");

    await expect(startPlannotatorServer({
      plan: "# Ready failure cleanup",
      origin: "codex",
      htmlContent: "<!doctype html><html><body>plan</body></html>",
      onReady: async () => {
        await Promise.resolve();
        throw readyError;
      },
    })).rejects.toBe(readyError);

    const replacement = Bun.serve({
      hostname: "127.0.0.1",
      port: start,
      fetch: () => new Response("reused"),
    });
    await replacement.stop(true);
  });

  const readyFailureCases: {
    name: string;
    start: (
      onReady: (url: string, isRemote: boolean, port: number) => Promise<void>,
      onCleanup: () => void,
    ) => Promise<unknown>;
  }[] = [
    {
      name: "annotate",
      start: (onReady) =>
        startAnnotateServer({
          markdown: "# Annotate ready failure",
          filePath: "ready-failure.md",
          htmlContent: "<!doctype html><html><body>annotate</body></html>",
          origin: "codex",
          sharingEnabled: false,
          onReady,
        }),
    },
    {
      name: "review",
      start: (onReady, onCleanup) =>
        startReviewServer({
          rawPatch: "",
          gitRef: "HEAD",
          htmlContent: "<!doctype html><html><body>review</body></html>",
          origin: "codex",
          sharingEnabled: false,
          onReady,
          onCleanup,
        }),
    },
    {
      name: "goal setup",
      start: (onReady) =>
        startGoalSetupServer({
          bundle: normalizeGoalSetupBundle({
            stage: "interview",
            title: "Ready failure",
            questions: [{ id: "scope", prompt: "Scope?" }],
          }),
          htmlContent: "<!doctype html><html><body>goal setup</body></html>",
          origin: "codex",
          onReady,
        }),
    },
  ];

  for (const readyFailureCase of readyFailureCases) {
    test(`${readyFailureCase.name} cleans up after an async ready failure`, async () => {
      environment.reset();
      const { start, servers } = await occupyConsecutivePorts(1);
      await closeServer(servers[0]);
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_PORT = String(start);
      process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
      process.env.PLANNOTATOR_SKIP_BROWSER_OPEN = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      const readyError = new Error(`${readyFailureCase.name} handoff failed`);
      let dismissed = 0;
      let cleanupCalls = 0;

      await expect(readyFailureCase.start(
        async (url, isRemote, port) => {
          await handleServerReady(url, isRemote, port, {
            presentUrl: async () => ({
              attempted: true,
              opened: true,
              presentation: {
                handle: { paneId: `pane-${readyFailureCase.name}` },
                dismiss: async () => {
                  dismissed += 1;
                  return { ok: true };
                },
              },
            }),
          });
          await Promise.resolve();
          throw readyError;
        },
        () => {
          cleanupCalls += 1;
        },
      )).rejects.toBe(readyError);

      expect(dismissed).toBe(1);
      expect(cleanupCalls).toBe(readyFailureCase.name === "review" ? 1 : 0);

      const replacement = Bun.serve({
        hostname: "127.0.0.1",
        port: start,
        fetch: () => new Response("reused"),
      });
      await replacement.stop(true);
    });
  }
});
