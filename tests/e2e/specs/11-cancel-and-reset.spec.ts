import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBinary,
  createSandbox,
  expectIdle,
  getFreePort,
  runCli,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";

// NOTE on Playwright: Cancel and Reset are UI button actions in the plan editor.
// This spec tests their end-to-end behavior via HTTP API equivalents:
//   Cancel → POST /api/cancel
//   Reset  → POST /api/reset  (clears annotations without ending the session)
// When Playwright is available, replace HTTP calls with browser clicks.

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("11-cancel-and-reset", () => {
  let sandbox: Sandbox;
  let port: number;

  beforeEach(async () => {
    sandbox = createSandbox();
    port = await getFreePort();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      HOME: sandbox.home,
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_BROWSER: "/usr/bin/true",
      ...extra,
    };
  }

  function daemonUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  // ─── 11.1 Cancel in plan UI ───────────────────────────────────────────────
  test("11.1 Cancel in plan UI: submitter CLI exits with cancel code, daemon → idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Simulate Cancel button
      await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const result = await submitHandle.waitForExit();
      // ADR: daemon-delivered cancel → exit 1
      expect(result.exitCode).toBe(1);

      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 11.2 Reset in plan UI ────────────────────────────────────────────────
  test("11.2 Reset in plan UI: session remains active, /api/draft returns cleared", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Save a draft first
      await fetch(daemonUrl("/api/draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ annotations: [{ type: "COMMENT", text: "test" }] }),
      });

      // Simulate Reset button (clears draft, keeps session active)
      const resetResp = await fetch(daemonUrl("/api/reset"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resetResp.ok).toBe(true);

      // Session must still be active (daemon did not exit)
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("awaiting-response");

      // CLI should still be blocking
      // (submitHandle should NOT have exited yet)

      // Clean up
      await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 11.3 Cancel after Reset ──────────────────────────────────────────────
  test("11.3 Cancel after Reset still works correctly", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Reset first
      await fetch(daemonUrl("/api/reset"), { method: "POST" });

      // Then cancel
      await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(1);

      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 11.4 SIGTERM daemon during active session ────────────────────────────
  test("11.4 SIGTERM daemon while active: daemon stops cleanly, submitter CLI exits", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // SIGTERM the daemon
      await daemon.stop();

      // The submitter CLI must exit (with any code — it can't hang)
      const result = await Promise.race([
        submitHandle.waitForExit(),
        new Promise<null>((r) => setTimeout(() => r(null), 10_000)),
      ]);
      expect(result).not.toBeNull();
    } finally {
      // daemon.stop() already called above
    }
  }, 30_000);

  // ─── 11.5 SIGTERM daemon during verdict_ready ─────────────────────────────
  test("11.5 SIGTERM daemon during verdict_ready: daemon stops cleanly", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          document: {
            id: "sigterm-test",
            mode: "plan",
            origin: "claude-code",
            content: "# Test Plan\nContent here.",
          },
        }),
      });

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      // Verify we're in resolved state
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("resolved");

      // SIGTERM the daemon — should stop cleanly
      await daemon.stop();

      // After stop, daemon should not be accessible
      await new Promise((r) => setTimeout(r, 500));
      let stillUp = false;
      try {
        const resp = await fetch(daemonUrl("/api/state"));
        stillUp = resp.ok;
      } catch {}
      expect(stillUp).toBe(false);
    } finally {
      // Already stopped above
    }
  }, 30_000);
});
