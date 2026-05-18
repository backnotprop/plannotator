import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getDaemonCapabilities } from "@plannotator/shared/daemon-protocol";
import { createDaemonState, getDaemonPaths, writeDaemonState } from "./state";
import { cleanupDaemonState, DaemonClient, discoverDaemon } from "./client";

let dirs: string[] = [];
const envKeys = ["PLANNOTATOR_REMOTE", "PLANNOTATOR_PORT", "SSH_TTY", "SSH_CONNECTION"];
const originalEnv: Record<string, string | undefined> = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);

function clearEnv() {
  for (const key of envKeys) delete process.env[key];
}

function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-daemon-client-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of envKeys) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function state() {
  return createDaemonState({
    pid: 123,
    port: 4321,
    hostname: "127.0.0.1",
    isRemote: false,
    remoteSource: "local",
    startedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("DaemonClient", () => {
  test("sends JSON body to daemon routes", async () => {
    const calls: Request[] = [];
    const client = new DaemonClient(state(), {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        calls.push(req);
        return Response.json({ ok: true, session: { id: "s1" } });
      },
    });

    await client.createSession({ request: { action: "plan", origin: "opencode", plan: "x" } });

    expect(calls[0].url).toBe("http://localhost:4321/daemon/sessions");
    expect(calls[0].headers.get("authorization")).toBeNull();
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(await calls[0].json()).toEqual({ request: { action: "plan", origin: "opencode", plan: "x" } });
  });

  test("passes explicit cleanup flag to session listing", async () => {
    const calls: Request[] = [];
    const client = new DaemonClient(state(), {
      fetch: async (input, init) => {
        const req = new Request(input, init);
        calls.push(req);
        return Response.json({ ok: true, sessions: [] });
      },
    });

    await client.listSessions({ clean: true });

    expect(calls[0].url).toBe("http://localhost:4321/daemon/sessions?clean=1");
  });

  test("turns non-JSON responses into daemon errors", async () => {
    const client = new DaemonClient(state(), {
      fetch: async () => new Response("nope", { status: 500 }),
    });
    const result = await client.status() as any;
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("daemon-unhealthy");
  });

  test("cleans daemon state when the recorded endpoint is unreachable", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(state(), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");
    const calls: Request[] = [];

    await cleanupDaemonState(state(), {
      baseDir,
      isAlive: () => false,
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        throw new Error("endpoint is gone");
      },
    });

    expect(calls.map((call) => call.url)).toEqual(["http://localhost:4321/daemon/shutdown"]);
    expect(calls[0].headers.get("content-type")).toBe("application/json");
    expect(await calls[0].text()).toBe("{}");
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("cleans unreachable daemon state even if the recorded PID has been reused", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(state(), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");

    await cleanupDaemonState(state(), {
      baseDir,
      shutdownTimeoutMs: 1,
      isAlive: () => true,
      fetch: async () => {
        throw new Error("endpoint is temporarily unreachable");
      },
    });

    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("cleans daemon files when the recorded port is another HTTP app", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(state(), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");

    await cleanupDaemonState(state(), {
      baseDir,
      fetch: async () => new Response("no", { status: 404 }),
    });

    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("keeps daemon files when a daemon rejects shutdown unexpectedly", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(state(), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");

    await expect(cleanupDaemonState(state(), {
      baseDir,
      fetch: async () => new Response("no", { status: 500 }),
    })).rejects.toThrow("rejected shutdown");

    expect(existsSync(paths.statePath)).toBe(true);
    expect(existsSync(paths.lockPath)).toBe(true);
  });

  test("waits for accepted shutdown before removing daemon files", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    const daemonState = state();
    writeDaemonState(daemonState, { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");
    let statusCalls = 0;
    let stateFileExistedDuringPoll = false;

    await cleanupDaemonState(daemonState, {
      baseDir,
      isAlive: () => true,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/daemon/shutdown")) return Response.json({ ok: true });
        if (url.endsWith("/daemon/status")) {
          statusCalls += 1;
          stateFileExistedDuringPoll = stateFileExistedDuringPoll || existsSync(paths.statePath);
          if (statusCalls === 1) return Response.json({ ...daemonState, ok: true });
          throw new Error("gone");
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    expect(statusCalls).toBe(2);
    expect(stateFileExistedDuringPoll).toBe(true);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("does not signal recorded PID when endpoint shutdown fails", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    writeDaemonState(state(), { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");
    const originalKill = process.kill;
    let killed = false;

    (process as typeof process & { kill: typeof process.kill }).kill = (() => {
      killed = true;
      return true;
    }) as typeof process.kill;

    try {
      await cleanupDaemonState(state(), {
        baseDir,
        shutdownTimeoutMs: 1,
        isAlive: () => true,
        fetch: async () => {
          throw new Error("endpoint is gone");
        },
      });
    } finally {
      (process as typeof process & { kill: typeof process.kill }).kill = originalKill;
    }

    expect(killed).toBe(false);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });

  test("retries shutdown before cleaning state when an unreachable daemon recovers", async () => {
    const baseDir = tempBase();
    const paths = getDaemonPaths({ baseDir });
    const daemonState = state();
    writeDaemonState(daemonState, { baseDir });
    writeFileSync(paths.lockPath, "123\n", "utf-8");
    let shutdownCalls = 0;
    let statusCalls = 0;

    await cleanupDaemonState(daemonState, {
      baseDir,
      isAlive: () => true,
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/daemon/shutdown")) {
          shutdownCalls += 1;
          if (shutdownCalls === 1) throw new Error("briefly unavailable");
          return Response.json({ ok: true });
        }
        if (url.endsWith("/daemon/status")) {
          statusCalls += 1;
          if (statusCalls === 1) return Response.json({ ok: true, pid: daemonState.pid });
          throw new Error("gone");
        }
        throw new Error(`unexpected request: ${url}`);
      },
    });

    expect(shutdownCalls).toBe(2);
    expect(statusCalls).toBe(2);
    expect(existsSync(paths.statePath)).toBe(false);
    expect(existsSync(paths.lockPath)).toBe(false);
  });
});

describe("discoverDaemon", () => {
  test("reports missing state", async () => {
    clearEnv();
    const result = await discoverDaemon({ baseDir: tempBase() });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("missing");
  });

  test("removes stale state", async () => {
    clearEnv();
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({ baseDir, isAlive: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("stale");
  });

  test("returns active daemon client when capabilities and status match", async () => {
    clearEnv();
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({
      baseDir,
      isAlive: (pid) => pid === 123,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/daemon/capabilities") return Response.json(getDaemonCapabilities());
        if (url.pathname === "/daemon/status") {
          return Response.json({
            ok: true,
            protocol: "plannotator-daemon",
            protocolVersion: 1,
            pid: 123,
            endpoint: {
              hostname: "127.0.0.1",
              port: 4321,
              baseUrl: "http://127.0.0.1:4321",
              isRemote: false,
            },
            startedAt: "2026-01-01T00:00:00.000Z",
            activeSessionCount: 0,
            sessionCount: 0,
          });
        }
        return Response.json({}, { status: 404 });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.pid).toBe(123);
    expect(result.client.state.baseUrl).toBe("http://localhost:4321");
  });

  test("rejects incompatible daemon capabilities", async () => {
    clearEnv();
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({
      baseDir,
      isAlive: () => true,
      fetch: async () => Response.json({ protocol: "other" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("incompatible");
  });

  test("rejects local/remote daemon mode mismatch", async () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({
      baseDir,
      isAlive: () => true,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/daemon/capabilities") return Response.json(getDaemonCapabilities());
        if (url.pathname === "/daemon/status") {
          return Response.json({
            ok: true,
            protocol: "plannotator-daemon",
            protocolVersion: 1,
            pid: 123,
            endpoint: {
              hostname: "127.0.0.1",
              port: 4321,
              baseUrl: "http://127.0.0.1:4321",
              isRemote: false,
            },
            startedAt: "2026-01-01T00:00:00.000Z",
            activeSessionCount: 0,
            sessionCount: 0,
          });
        }
        return Response.json({}, { status: 404 });
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("mismatch");
  });

  test("can bypass environment mismatch checks for management commands", async () => {
    clearEnv();
    process.env.PLANNOTATOR_REMOTE = "1";
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({
      baseDir,
      validateEnvironment: false,
      isAlive: () => true,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/daemon/capabilities") return Response.json(getDaemonCapabilities());
        if (url.pathname === "/daemon/status") {
          return Response.json({
            ok: true,
            protocol: "plannotator-daemon",
            protocolVersion: 1,
            pid: 123,
            endpoint: {
              hostname: "127.0.0.1",
              port: 4321,
              baseUrl: "http://127.0.0.1:4321",
              isRemote: false,
            },
            startedAt: "2026-01-01T00:00:00.000Z",
            activeSessionCount: 0,
            sessionCount: 0,
          });
        }
        return Response.json({}, { status: 404 });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status.endpoint.isRemote).toBe(false);
  });

  test("rejects explicit port mismatch", async () => {
    clearEnv();
    process.env.PLANNOTATOR_PORT = "9999";
    const baseDir = tempBase();
    writeDaemonState(state(), { baseDir });
    const result = await discoverDaemon({
      baseDir,
      isAlive: () => true,
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/daemon/capabilities") return Response.json(getDaemonCapabilities());
        if (url.pathname === "/daemon/status") {
          return Response.json({
            ok: true,
            protocol: "plannotator-daemon",
            protocolVersion: 1,
            pid: 123,
            endpoint: {
              hostname: "127.0.0.1",
              port: 4321,
              baseUrl: "http://127.0.0.1:4321",
              isRemote: false,
            },
            startedAt: "2026-01-01T00:00:00.000Z",
            activeSessionCount: 0,
            sessionCount: 0,
          });
        }
        return Response.json({}, { status: 404 });
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("mismatch");
  });
});
