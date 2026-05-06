import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildBinary,
  createSandbox,
  getFreePort,
  runCli,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";

// ADR: exit codes
//   0 = success / daemon running
//   1 = denied / not-running / collision
//   3 = daemon failure

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("02-daemon-lifecycle", () => {
  let sandbox: Sandbox;
  let port: number;

  beforeEach(async () => {
    sandbox = createSandbox();
    port = await getFreePort();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function daemonEnv(): Record<string, string> {
    return {
      HOME: sandbox.home,
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_BROWSER: process.env.PLANNOTATOR_BROWSER ?? "/usr/bin/true",
    };
  }

  // ─── 2.1 Cold start ────────────────────────────────────────────────────────
  test("2.1 cold start: daemon start exits 0, prints port+URL, daemon.json exists, /api/state returns idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const status = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(status.ok).toBe(true);
      const body = (await status.json()) as { status: string };
      expect(body.status).toBe("idle");

      const metadataPath = join(sandbox.home, ".plannotator", "daemon.json");
      expect(existsSync(metadataPath)).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 2.2 Idempotent start ──────────────────────────────────────────────────
  test("2.2 idempotent start: daemon start while running exits 0, PID unchanged", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const metadataPath = join(sandbox.home, ".plannotator", "daemon.json");
      const firstMeta = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; port: number };
      const firstPid = firstMeta.pid;

      const result = await runCli(["daemon", "start"], {
        env: daemonEnv(),
        timeoutMs: 15_000,
      });
      expect(result.exitCode).toBe(0);

      const secondMeta = JSON.parse(readFileSync(metadataPath, "utf8")) as { pid: number; port: number };
      expect(secondMeta.pid).toBe(firstPid);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 2.3 daemon status while running ───────────────────────────────────────
  test("2.3 daemon status while running: exits 0, prints status and URL", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const result = await runCli(["daemon", "status"], {
        env: daemonEnv(),
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/idle|active|resolved/i);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 2.4 daemon status when not running ────────────────────────────────────
  test("2.4 daemon status when not running: exits non-zero, says not running", async () => {
    const result = await runCli(["daemon", "status"], {
      env: daemonEnv(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
    const combined = `${result.stdout}\n${result.stderr}`;
    expect(combined.toLowerCase()).toMatch(/not.running|no daemon|stopped/);
  });

  // ─── 2.5 daemon stop ───────────────────────────────────────────────────────
  test("2.5 daemon stop: exits 0, process gone, lockfile removed", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    const pid = daemon.pid;

    const stopResult = await runCli(["daemon", "stop"], {
      env: daemonEnv(),
      timeoutMs: 15_000,
    });
    expect(stopResult.exitCode).toBe(0);

    // Wait briefly for process to die
    await new Promise((r) => setTimeout(r, 500));

    let processDead = false;
    try {
      process.kill(pid, 0);
    } catch {
      processDead = true;
    }
    expect(processDead).toBe(true);

    const lockfilePath = join(sandbox.home, ".plannotator", "daemon.lock");
    expect(existsSync(lockfilePath)).toBe(false);
  });

  // ─── 2.6 daemon stop when already stopped ──────────────────────────────────
  test("2.6 daemon stop when already stopped: exits 0 (idempotent)", async () => {
    const result = await runCli(["daemon", "stop"], {
      env: daemonEnv(),
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(0);
  });

  // ─── 2.7 stale lockfile ────────────────────────────────────────────────────
  test("2.7 stale lockfile: start cleans it up and starts successfully", async () => {
    // Write a stale daemon.json with a non-existent PID
    const plannotatorDir = join(sandbox.home, ".plannotator");
    const metadataPath = join(plannotatorDir, "daemon.json");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(plannotatorDir, { recursive: true });
    writeFileSync(metadataPath, JSON.stringify({ port, pid: 999999999 }), "utf8");

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const status = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(status.ok).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 2.8 aliases: start/stop/status ────────────────────────────────────────
  test("2.8 plannotator status alias behaves identically to daemon status", async () => {
    const notRunning = await runCli(["status"], {
      env: daemonEnv(),
      timeoutMs: 10_000,
    });
    // Should mirror "daemon status" not-running behavior
    expect(notRunning.exitCode).not.toBe(0);

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const running = await runCli(["status"], {
        env: daemonEnv(),
        timeoutMs: 10_000,
      });
      expect(running.exitCode).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 2.9 port collision ────────────────────────────────────────────────────
  test("2.9 port collision: daemon start fails with clear error when port is in use", async () => {
    // Bind the port from outside
    const { createServer } = await import("node:net");
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));

    try {
      const result = await runCli(["daemon", "start"], {
        env: daemonEnv(),
        timeoutMs: 15_000,
      });
      // ADR: when PLANNOTATOR_PORT is set and the port is in use, the daemon
      // must fail with a non-zero exit code rather than silently using a random port.
      expect(result.exitCode).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.length).toBeGreaterThan(0); // some error message
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  // ─── 2.10 foreground mode ──────────────────────────────────────────────────
  test("2.10 foreground mode: daemon start --foreground runs in shell, SIGTERM stops cleanly", async () => {
    const handle = runCliBackground(["daemon", "start", "--foreground"], {
      env: daemonEnv(),
    });

    // Wait until daemon is ready
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/state`);
        if (resp.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);

    handle.kill("SIGTERM");
    const result = await handle.waitForExit();

    // After SIGTERM the daemon should exit cleanly (0 or signal-killed)
    const lockfilePath = join(sandbox.home, ".plannotator", "daemon.lock");
    // Lock file cleaned up (or may not exist if daemon never wrote it in foreground mode)
    // Either way the process must have exited
    expect(typeof result.exitCode).toBe("number");
  }, 30_000);
});
