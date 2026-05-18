import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readDaemonState } from "./state";
import { startDaemonRuntime, type DaemonRuntime } from "./runtime";

let dirs: string[] = [];
let runtimes: DaemonRuntime[] = [];
const shellHtml = "<html><head></head><body>Shell</body></html>";

function daemonAuthHeaders(runtime: DaemonRuntime, headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  next.set("authorization", `Bearer ${runtime.state.authToken}`);
  return next;
}

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-daemon-runtime-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const runtime of runtimes) await runtime.stop();
  runtimes = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe("startDaemonRuntime", () => {
  test("starts an HTTP daemon and writes active state", async () => {
    const baseDir = tempBase();
    const runtime = await startDaemonRuntime({
      baseDir,
      hostname: "127.0.0.1",
      port: 0,
      shellHtmlContent: shellHtml,
      createSession: (_request, { endpoint }) => runtime.store.create({
        id: "s1",
        mode: "plan",
        url: `${endpoint.baseUrl}/s/s1`,
        project: "repo",
        label: "plan",
      }),
    });
    runtimes.push(runtime);

    const state = readDaemonState({ baseDir, isAlive: (pid) => pid === process.pid });
    expect(state.kind).toBe("active");
    if (state.kind !== "active") return;
    expect(state.state.port).toBe(runtime.server.port);

    const caps = await fetch(`${runtime.state.baseUrl}/daemon/capabilities`);
    expect((await caps.json()).multiSession).toBe(true);
  });

  test("rejects a second daemon for the same state directory", async () => {
    const baseDir = tempBase();
    const runtime = await startDaemonRuntime({
      baseDir,
      hostname: "127.0.0.1",
      port: 0,
      shellHtmlContent: shellHtml,
      createSession: (_request, { endpoint }) => runtime.store.create({
        id: "s1",
        mode: "plan",
        url: `${endpoint.baseUrl}/s/s1`,
        project: "repo",
        label: "plan",
      }),
    });
    runtimes.push(runtime);

    await expect(startDaemonRuntime({
      baseDir,
      hostname: "127.0.0.1",
      port: 0,
      shellHtmlContent: shellHtml,
      createSession: () => {
        throw new Error("should not create");
      },
    })).rejects.toThrow("lock");
  });

  test("shutdown route stops daemon and removes state", async () => {
    const baseDir = tempBase();
    const runtime = await startDaemonRuntime({
      baseDir,
      hostname: "127.0.0.1",
      port: 0,
      shellHtmlContent: shellHtml,
      createSession: (_request, { endpoint }) => runtime.store.create({
        id: "s1",
        mode: "plan",
        url: `${endpoint.baseUrl}/s/s1`,
        project: "repo",
        label: "plan",
      }),
    });

    const res = await fetch(`${runtime.state.baseUrl}/daemon/shutdown`, {
      method: "POST",
      headers: daemonAuthHeaders(runtime, { "content-type": "application/json" }),
      body: "{}",
    });
    expect((await res.json()).shuttingDown).toBe(true);
    for (let attempt = 0; attempt < 20 && readDaemonState({ baseDir }).kind !== "missing"; attempt++) {
      await Bun.sleep(10);
    }
    expect(readDaemonState({ baseDir }).kind).toBe("missing");
  });

  test("logs unhandled request errors through the daemon error handler", async () => {
    const baseDir = tempBase();
    const originalError = console.error;
    const errorMock = mock(() => {});
    console.error = errorMock as typeof console.error;
    const runtime = await startDaemonRuntime({
      baseDir,
      hostname: "127.0.0.1",
      port: 0,
      shellHtmlContent: shellHtml,
      createSession: (_request, { endpoint, store }) => store.create({
        id: "s1",
        mode: "plan",
        url: `${endpoint.baseUrl}/s/s1`,
        project: "repo",
        label: "plan",
        handleRequest: () => {
          throw new Error("session boom");
        },
      }),
    });
    runtimes.push(runtime);

    try {
      const create = await fetch(`${runtime.state.baseUrl}/daemon/sessions`, {
        method: "POST",
        headers: daemonAuthHeaders(runtime, { "content-type": "application/json" }),
        body: JSON.stringify({ request: { action: "plan", origin: "opencode", cwd: process.cwd(), plan: "# Plan" } }),
      });
      expect(create.status).toBe(201);

      const res = await fetch(`${runtime.state.baseUrl}/s/s1/api/plan`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Internal Plannotator daemon error");
      expect(errorMock).toHaveBeenCalled();
    } finally {
      console.error = originalError;
    }
  });
});
