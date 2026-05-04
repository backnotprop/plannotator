import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  buildBinary,
  createSandbox,
  expectActive,
  expectIdle,
  expectVerdictReady,
  getFreePort,
  runCli,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

// ADR: state status values
//   "idle"              - no active document
//   "awaiting-response" - document submitted, waiting for user action
//   "resolved"          - verdict ready to be consumed by plannotator wait

// ADR: exit codes used in this spec
//   0   = approved / command succeeded
//   1   = denied / collision / cancelled (daemon-delivered)
//   2   = illegal-state rejection
//   130 = local signal cancel

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("03-state-machine", () => {
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

  function sampleDocument() {
    return {
      id: `test-${Date.now()}`,
      mode: "plan",
      origin: "claude-code",
      content: readFileSync(join(FIXTURES_DIR, "small.md"), "utf8"),
    };
  }

  // ─── 3.1 Legal transitions ─────────────────────────────────────────────────

  test("3.1.1 idle → awaiting-response via POST /api/submit", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);

      const resp = await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      expect(resp.status).toBe(202);

      await expectActive(port, { mode: "plan" });
    } finally {
      await daemon.stop();
    }
  });

  test("3.1.2 awaiting-response → resolved via POST /api/approve", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      await expectActive(port);

      const resp = await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      expect(resp.ok).toBe(true);

      await expectVerdictReady(port);
    } finally {
      await daemon.stop();
    }
  });

  test("3.1.3 awaiting-response → resolved via POST /api/deny", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });

      const resp = await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "needs more detail" }),
      });
      expect(resp.ok).toBe(true);

      await expectVerdictReady(port);
    } finally {
      await daemon.stop();
    }
  });

  test("3.1.4 awaiting-response → resolved via POST /api/cancel", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });

      const resp = await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(resp.ok).toBe(true);

      // Cancel resolves into the "resolved" state (feedback.cancelled=true),
      // which is then consumed by wait → back to idle.
      // The state may briefly be "resolved" before the waiting CLI consumes it.
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string; feedback?: { cancelled?: boolean } };
      expect(["resolved", "idle"]).toContain(state.status);
    } finally {
      await daemon.stop();
    }
  });

  test("3.1.5 resolved → idle via GET /api/wait consuming verdict", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Submit + approve to reach resolved state
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await expectVerdictReady(port);

      // Consume verdict via CLI wait
      const waitResult = await runCli(["wait"], {
        env: env(),
        timeoutMs: 15_000,
      });
      expect(waitResult.exitCode).toBe(0);

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  test("3.1.6 any state → idle via POST /api/clear (force from awaiting-response)", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      await expectActive(port);

      const resp = await fetch(daemonUrl("/api/clear"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      expect(resp.ok).toBe(true);

      // After forced clear of awaiting-response, daemon emits a cancelled verdict
      // which may briefly leave state as "resolved" before consumption.
      await new Promise((r) => setTimeout(r, 200));
      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(["idle", "resolved"]).toContain(state.status);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 3.2 Illegal transitions ───────────────────────────────────────────────

  test("3.2.1 submitting while active: CLI exits with collision exit code 1", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // First submission (runs in background, blocks waiting for verdict)
      const firstSubmit = runCliBackground(["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"], {
        env: env(),
      });

      // Wait until daemon is active
      const deadline = Date.now() + 10_000;
      let active = false;
      while (Date.now() < deadline && !active) {
        try {
          const resp = await fetch(daemonUrl("/api/state"));
          const body = (await resp.json()) as { status: string };
          if (body.status === "awaiting-response") {
            active = true;
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(active).toBe(true);

      // Second submission — should be rejected
      const secondResult = await runCli(
        ["submit", join(FIXTURES_DIR, "multi-section.md"), "--no-browser"],
        { env: env(), timeoutMs: 10_000 },
      );
      expect(secondResult.exitCode).toBe(1);

      // Verify the error message mentions recovery options
      const combined = `${secondResult.stdout}\n${secondResult.stderr}`;
      expect(combined.toLowerCase()).toMatch(/clear|collision|active/);

      // Clean up the first background submit
      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await firstSubmit.waitForExit();
    } finally {
      await daemon.stop();
    }
  });

  test("3.2.3 raw POST /api/submit while active returns HTTP 409", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      await expectActive(port);

      const second = await fetch(daemonUrl("/api/submit"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: sampleDocument() }),
      });
      expect(second.status).toBe(409);

      const body = (await second.json()) as { error?: string };
      expect(typeof body.error).toBe("string");
      expect((body.error ?? "").length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  test("3.2.4 collision error message contains the recovery command", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const firstSubmit = runCliBackground(["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"], {
        env: env(),
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const secondResult = await runCli(
        ["submit", join(FIXTURES_DIR, "multi-section.md"), "--no-browser"],
        { env: env(), timeoutMs: 10_000 },
      );
      const combined = `${secondResult.stdout}\n${secondResult.stderr}`;

      // ADR: the collision message must contain this exact command so users know how to recover.
      expect(combined).toContain("plannotator clear --force");

      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await firstSubmit.waitForExit();
    } finally {
      await daemon.stop();
    }
  });

  // ─── 3.3 Verdict-consumption semantics ────────────────────────────────────

  test("3.3.1 submit + approve → wait exits 0 with verdict, state → idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"], {
        env: env(),
      });

      // Wait until active
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Approve via HTTP (simulating UI button click)
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "looks good", annotations: [] }),
      });

      const submitResult = await submitHandle.waitForExit();
      expect(submitResult.exitCode).toBe(0);

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  test("3.3.2 submit + deny → wait exits 1, output contains feedback, state → idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"], {
        env: env(),
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Deny with feedback
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "needs more detail on error handling" }),
      });

      const submitResult = await submitHandle.waitForExit();
      // ADR: denied plan → exit code 1
      expect(submitResult.exitCode).toBe(1);

      const combined = `${submitResult.stdout}\n${submitResult.stderr}`;
      expect(combined).toContain("needs more detail on error handling");

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  test("3.3.3 submit + cancel → submit exits 1, state → idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"], {
        env: env(),
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Cancel via HTTP (simulating Cancel button in UI)
      await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const submitResult = await submitHandle.waitForExit();
      // ADR: daemon-delivered cancel → exit code 1 (not 130; 130 is for signal cancel)
      expect(submitResult.exitCode).toBe(1);

      await new Promise((r) => setTimeout(r, 200));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });
});
