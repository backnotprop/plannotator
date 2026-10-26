/**
 * PLANNOTATOR_LIVE_PORT on the Bun live proxy (#2145) and on the Bun annotate
 * server that starts it. The Node/Pi twins are
 * packages/shared/live-proxy-node-port.test.ts and
 * apps/pi-extension/server/serverAnnotate-live-port.test.ts.
 *
 * Busy ports are real listeners this file starts and closes; free ports come
 * from the OS.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  accepts,
  canBind,
  closeServer,
  deniedLowPort,
  nonLoopbackIPv4,
  occupyConsecutivePorts,
  partlyBusyRange,
  reserveFreePort,
} from "../../tests/helpers/live-port";
import { LiveProxyPortError, LiveProxyPortInUseError } from "@plannotator/shared/live-proxy-port";
import { startLiveAppProxy, type LiveAppProxy } from "./live-proxy";
import { startAnnotateServer } from "./annotate";

const ENV_KEYS = ["PLANNOTATOR_LIVE_PORT", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let upstream: ReturnType<typeof Bun.serve>;
const proxies: LiveAppProxy[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PLANNOTATOR_REMOTE = "0";
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<html><head></head><body>app</body></html>", {
      headers: { "Content-Type": "text/html" },
    }),
  });
});

afterEach(() => {
  for (const proxy of proxies.splice(0)) proxy.stop();
  upstream.stop(true);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function startProxy(): LiveAppProxy {
  const proxy = startLiveAppProxy({
    targetUrl: `http://127.0.0.1:${upstream.port}`,
    editorOrigins: ["http://localhost:4100"],
    bridgeJs: "/* bridge */",
  });
  proxies.push(proxy);
  return proxy;
}

async function expectServesApp(proxy: LiveAppProxy) {
  const res = await fetch(`${proxy.origin}/`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("app");
}

describe("Bun live proxy: PLANNOTATOR_LIVE_PORT", () => {
  test("unset keeps a random loopback port", async () => {
    const proxy = startProxy();
    expect(proxy.port).toBeGreaterThan(0);
    expect(proxy.origin).toBe(`http://127.0.0.1:${proxy.port}`);
    await expectServesApp(proxy);
  });

  test("a fixed free port is used, on 127.0.0.1 only", async () => {
    const port = await reserveFreePort();
    process.env.PLANNOTATOR_LIVE_PORT = String(port);
    const proxy = startProxy();
    expect(proxy.port).toBe(port);
    expect(proxy.origin).toBe(`http://127.0.0.1:${port}`);
    await expectServesApp(proxy);
    const lan = nonLoopbackIPv4();
    if (lan) expect(await accepts(lan, port)).toBe(false);
  });

  test("a range whose first port is busy falls through to the next", async () => {
    const range = await partlyBusyRange(3, 1);
    try {
      process.env.PLANNOTATOR_LIVE_PORT = `${range.start}-${range.end}`;
      const proxy = startProxy();
      expect(proxy.port).toBe(range.start + 1);
      await expectServesApp(proxy);
    } finally {
      await range.release();
    }
  });

  test("every port busy raises LiveProxyPortInUseError", async () => {
    const { start, servers } = await occupyConsecutivePorts(2);
    try {
      process.env.PLANNOTATOR_LIVE_PORT = `${start}-${start + 1}`;
      expect(() => startProxy()).toThrow(LiveProxyPortInUseError);
      process.env.PLANNOTATOR_LIVE_PORT = String(start);
      expect(() => startProxy()).toThrow(
        `port ${start} (PLANNOTATOR_LIVE_PORT) is already in use`,
      );
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  });

  test("an invalid value warns and falls back to a random port", async () => {
    const warn = spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.PLANNOTATOR_LIVE_PORT = "not-a-port";
      const proxy = startProxy();
      expect(proxy.port).toBeGreaterThan(0);
      expect(warn).toHaveBeenCalledWith('[Plannotator] Warning: Invalid PLANNOTATOR_LIVE_PORT "not-a-port", using default');
      await expectServesApp(proxy);
    } finally {
      warn.mockRestore();
    }
  });

  // Bun.serve reports a denied port as "Is port N in use?" (EADDRINUSE); the
  // proxy asks Bun.listen for the real code. Skipped where low ports bind.
  test("a port this user may not bind is one clear line, and a range moves past it", async () => {
    const denied = await deniedLowPort();
    if (denied === null) {
      console.log("skip: no denied low port here (root, or low ports are open)");
      return;
    }
    process.env.PLANNOTATOR_LIVE_PORT = String(denied);
    let thrown: unknown;
    try {
      startProxy();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LiveProxyPortError);
    expect(thrown).not.toBeInstanceOf(LiveProxyPortInUseError);
    expect((thrown as Error).message).toBe(
      `Plannotator: live app proxy port ${denied} (PLANNOTATOR_LIVE_PORT) could not be used (EACCES: permission denied). Ports below 1024 usually need root. Set PLANNOTATOR_LIVE_PORT to a different port or range.`,
    );

    // A range from the denied port across 1024: it moves past the denied
    // ports (and any busy one) and lands on 1024 or later.
    process.env.PLANNOTATOR_LIVE_PORT = `${denied}-1060`;
    const proxy = startProxy();
    expect(proxy.port).toBeGreaterThanOrEqual(1024);
    expect(proxy.port).toBeLessThanOrEqual(1060);
    await expectServesApp(proxy);
  });
});

describe("Bun annotate server: a live proxy that cannot bind", () => {
  test("rejects and leaves no listener open, the editor's included", async () => {
    const editorPort = await reserveFreePort();
    const { start, servers } = await occupyConsecutivePorts(2);
    try {
      process.env.PLANNOTATOR_PORT = String(editorPort);
      process.env.PLANNOTATOR_LIVE_PORT = `${start}-${start + 1}`;
      const targetUrl = `http://127.0.0.1:${upstream.port}`;
      await expect(startAnnotateServer({
        markdown: "",
        filePath: targetUrl,
        htmlContent: "<html><body>editor</body></html>",
        mode: "annotate-app",
        sourceInfo: targetUrl,
        liveApp: {
          targetUrl,
          bridgeScript: "/* bridge */",
          bridgeBootstrap: "/* bootstrap */",
          annotationCss: "",
        },
      })).rejects.toBeInstanceOf(LiveProxyPortInUseError);
      expect(await accepts("127.0.0.1", editorPort)).toBe(false);
      expect(await canBind(editorPort)).toBe(true);
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  });
});
