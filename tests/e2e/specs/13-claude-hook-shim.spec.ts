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
  startDaemon,
  type Sandbox,
} from "../helpers";

// The Claude Code hook shim is the binary's default entrypoint:
// Claude Code pipes a PermissionRequest JSON event into stdin (no subcommand),
// the binary forwards the plan to the daemon, waits for verdict, then writes
// the hookSpecificOutput JSON to stdout.
//
// Input JSON shape (Claude Code hook event):
//   { tool_input: { plan: string }, hook_event_name: "PermissionRequest" }
//
// Approve output:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }
//
// Deny output:
//   { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "YOUR PLAN WAS NOT APPROVED..." } } }

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/plans",
);

function makeHookEvent(plan: string): string {
  return JSON.stringify({
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: { plan },
  });
}

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("13-claude-hook-shim", () => {
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

  // ─── 13.1 approve flow ─────────────────────────────────────────────────────
  test("13.1 hook event stdin + approve → hookSpecificOutput.decision.behavior=allow", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const plan = readFileSync(join(FIXTURES_DIR, "small.md"), "utf8");
      const hookEventJson = makeHookEvent(plan);

      // Start the shim (no subcommand) with the hook event on stdin
      let hookResult: { exitCode: number; stdout: string; stderr: string } | null = null;
      const hookPromise = runCli([], {
        env: env(),
        stdin: hookEventJson,
        timeoutMs: 30_000,
      }).then((r) => {
        hookResult = r;
      });

      // Wait until daemon has the plan
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Approve via HTTP
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      await hookPromise;
      expect(hookResult).not.toBeNull();
      const result = hookResult!;

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        hookSpecificOutput?: {
          hookEventName?: string;
          decision?: { behavior?: string };
        };
      };
      expect(parsed.hookSpecificOutput?.decision?.behavior).toBe("allow");
      expect(parsed.hookSpecificOutput?.hookEventName).toBe("PermissionRequest");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 13.2 deny flow ────────────────────────────────────────────────────────
  test("13.2 hook event stdin + deny → hookSpecificOutput.decision.behavior=deny with message", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const plan = readFileSync(join(FIXTURES_DIR, "small.md"), "utf8");

      let hookResult: { exitCode: number; stdout: string; stderr: string } | null = null;
      const hookPromise = runCli([], {
        env: env(),
        stdin: makeHookEvent(plan),
        timeoutMs: 30_000,
      }).then((r) => {
        hookResult = r;
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "add error handling section" }),
      });

      await hookPromise;
      const result = hookResult!;

      // ADR: hook deny → exits 0 (the hook JSON itself carries the deny decision)
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim()) as {
        hookSpecificOutput?: {
          decision?: { behavior?: string; message?: string };
        };
      };
      expect(parsed.hookSpecificOutput?.decision?.behavior).toBe("deny");
      const message = parsed.hookSpecificOutput?.decision?.message ?? "";
      // ADR: deny message must contain this prefix so Claude knows to revise
      expect(message).toContain("YOUR PLAN WAS NOT APPROVED");
      expect(message).toContain("add error handling section");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 13.3 daemon not running when hook fires ───────────────────────────────
  test("13.3 daemon not running: binary auto-starts daemon and processes hook", async () => {
    // No daemon is pre-started for this test; the binary should auto-start it.
    const plan = readFileSync(join(FIXTURES_DIR, "small.md"), "utf8");

    let hookResult: { exitCode: number; stdout: string; stderr: string } | null = null;
    const hookPromise = runCli([], {
      env: env(),
      stdin: makeHookEvent(plan),
      timeoutMs: 30_000,
    }).then((r) => {
      hookResult = r;
    });

    // Wait for daemon to auto-start
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const resp = await fetch(daemonUrl("/api/state"));
        if (resp.ok) ready = true;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }

    if (ready) {
      // Daemon auto-started; approve the plan
      const activeDeadline = Date.now() + 5_000;
      while (Date.now() < activeDeadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await hookPromise;
      const result = hookResult!;
      expect(result.exitCode).toBe(0);

      // Cleanup: stop the auto-started daemon
      await runCli(["daemon", "stop"], { env: env(), timeoutMs: 10_000 });
    } else {
      // ADR: if the binary doesn't auto-start the daemon, it must fail with
      // a clear stderr message rather than hanging.
      await hookPromise;
      const result = hookResult!;
      expect(result.exitCode).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.length).toBeGreaterThan(0);
    }
  }, 50_000);

  // ─── 13.4 malformed stdin JSON ─────────────────────────────────────────────
  test("13.4 malformed stdin JSON: exits non-zero, clear error, daemon state unchanged", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);

      const result = await runCli([], {
        env: env(),
        stdin: "{ this is not valid JSON }",
        timeoutMs: 15_000,
      });

      expect(result.exitCode).not.toBe(0);

      // Daemon state must still be idle — malformed input must not corrupt state
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 13.5 concurrent hook invocations ─────────────────────────────────────
  test("13.5 two concurrent hooks: second gets deny envelope with collision message", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const plan = readFileSync(join(FIXTURES_DIR, "small.md"), "utf8");

      // Start first hook — blocks
      let firstResult: { exitCode: number; stdout: string; stderr: string } | null = null;
      const firstHookPromise = runCli([], {
        env: env(),
        stdin: makeHookEvent(plan),
        timeoutMs: 30_000,
      }).then((r) => {
        firstResult = r;
      });

      // Wait until first is active
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Start second hook (should hit collision path)
      const secondResult = await runCli([], {
        env: env(),
        stdin: makeHookEvent(readFileSync(join(FIXTURES_DIR, "multi-section.md"), "utf8")),
        timeoutMs: 10_000,
      });

      // ADR: second hook must return a deny envelope so Claude knows what happened.
      // It must NOT hang or silently discard the collision.
      expect(secondResult.exitCode).toBe(0); // hook exits 0; decision carries the error
      const parsed = JSON.parse(secondResult.stdout.trim()) as {
        hookSpecificOutput?: {
          decision?: { behavior?: string; message?: string };
        };
      };
      expect(parsed.hookSpecificOutput?.decision?.behavior).toBe("deny");
      expect((parsed.hookSpecificOutput?.decision?.message ?? "").length).toBeGreaterThan(0);

      // Clean up the first hook
      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await firstHookPromise;
    } finally {
      await daemon.stop();
    }
  }, 50_000);
});
