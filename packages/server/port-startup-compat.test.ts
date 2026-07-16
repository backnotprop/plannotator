import { afterEach, describe, expect, test } from "bun:test";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import { startPlannotatorServer } from "./index";
import { handleServerReady } from "./shared-handlers";

const envKeys = [
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_SKIP_BROWSER_OPEN",
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
      server.stop();
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
      server.stop();
    }
  });
});
