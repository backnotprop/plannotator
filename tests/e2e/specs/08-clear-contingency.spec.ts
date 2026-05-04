import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// ADR: /api/clear behavior
//   POST /api/clear {}            when idle              → HTTP 409 ("already idle")
//   POST /api/clear {}            when awaiting-response → HTTP 409 (refuse without force)
//   POST /api/clear { force:true} when awaiting-response → HTTP 200 (forced clear, emits cancelled verdict)
//   POST /api/clear {}            when resolved          → HTTP 200 (clear buffered verdict, no force needed)
//   POST /api/clear { force:true} when resolved          → HTTP 200 (same as above)

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("08-clear-contingency", () => {
  let sandbox: Sandbox;
  let port: number;

  beforeEach(async () => {
    sandbox = createSandbox();
    port = await getFreePort();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  function env(): Record<string, string> {
    return {
      HOME: sandbox.home,
      PLANNOTATOR_PORT: String(port),
      PLANNOTATOR_BROWSER: "/usr/bin/true",
    };
  }

  function daemonUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function sampleDoc() {
    return {
      id: `clear-test-${Date.now()}`,
      mode: "plan",
      origin: "claude-code",
      content: readFileSync(join(FIXTURES_DIR, "small.md"), "utf8"),
    };
  }

  // ─── 8.1 clear when idle (CLI) ─────────────────────────────────────────────
  test("8.1 plannotator clear when idle: exits 0, reports nothing to clear", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);
      const result = await runCli(["clear"], { env: env(), timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.toLowerCase()).toMatch(/idle|nothing|already/);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 8.2 clear without --force when active ─────────────────────────────────
  test("8.2 plannotator clear (no --force) when active: exits non-zero, does NOT clear", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDoc() }),
      });

      const result = await runCli(["clear"], { env: env(), timeoutMs: 10_000 });
      expect(result.exitCode).not.toBe(0);

      // State must still be awaiting-response — not cleared
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("awaiting-response");
    } finally {
      // Force-clear so daemon stops cleanly
      await fetch(daemonUrl("/api/clear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      await daemon.stop();
    }
  });

  // ─── 8.3 clear --force from active ────────────────────────────────────────
  test("8.3 plannotator clear --force from active: exits 0, submitter CLI receives cancel", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      // Wait for active
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const clearResult = await runCli(["clear", "--force"], {
        env: env(),
        timeoutMs: 10_000,
      });
      expect(clearResult.exitCode).toBe(0);

      const submitResult = await submitHandle.waitForExit();
      // ADR: forced clear cancels the in-flight submission; submitter exits 1 (cancelled)
      expect(submitResult.exitCode).toBe(1);

      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 8.4 clear --force from verdict_ready ─────────────────────────────────
  test("8.4 plannotator clear --force from verdict_ready: exits 0, state → idle, verdict discarded", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDoc() }),
      });
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      // State is now resolved (verdict_ready)
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("resolved");

      const clearResult = await runCli(["clear", "--force"], {
        env: env(),
        timeoutMs: 10_000,
      });
      expect(clearResult.exitCode).toBe(0);

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 8.5 clear --force from idle ──────────────────────────────────────────
  test("8.5 plannotator clear --force from idle: exits 0 (no-op)", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);
      const result = await runCli(["clear", "--force"], { env: env(), timeoutMs: 10_000 });
      expect(result.exitCode).toBe(0);
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 8.6 raw POST /api/clear with { force: true } ─────────────────────────
  test("8.6 POST /api/clear { force: true } from active mirrors --force behavior", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDoc() }),
      });

      const resp = await fetch(daemonUrl("/api/clear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(resp.ok).toBe(true);

      // State transitions away from awaiting-response
      await new Promise((r) => setTimeout(r, 300));
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(["idle", "resolved"]).toContain(state.status);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 8.7 raw POST /api/clear without force when active ────────────────────
  test("8.7 POST /api/clear {} from active (no force): returns HTTP 409", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDoc() }),
      });

      const resp = await fetch(daemonUrl("/api/clear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      // ADR: refusing to clear in-flight submission without explicit force
      expect(resp.status).toBe(409);
    } finally {
      await fetch(daemonUrl("/api/clear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      await daemon.stop();
    }
  });
});
