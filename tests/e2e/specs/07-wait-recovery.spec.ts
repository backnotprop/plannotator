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

// ADR: exit codes for wait
//   0   = verdict approved (or review/annotate feedback delivered)
//   1   = verdict denied, cancelled (daemon-delivered), or idle-with-no-session
//   2   = illegal-state (no active session at all)

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("07-wait-recovery", () => {
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
      id: `wait-test-${Date.now()}`,
      mode: "plan",
      origin: "claude-code",
      content: readFileSync(join(FIXTURES_DIR, "small.md"), "utf8"),
    };
  }

  // ─── 7.1 SIGKILL submitter, then wait from fresh terminal → approved ────────
  test("7.1 SIGKILL the submitter CLI, then run wait from fresh terminal → approved verdict", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Start a blocking submit (will be killed)
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      // Wait until active
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Kill the submitter CLI process — simulates agent process death
      submitHandle.kill("SIGKILL");
      await submitHandle.waitForExit();

      // Daemon still holds the session; approve via HTTP (simulating UI action)
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "looks great", annotations: [] }),
      });

      // Fresh terminal: plannotator wait collects the buffered verdict
      const waitResult = await runCli(["wait"], { env: env(), timeoutMs: 15_000 });
      expect(waitResult.exitCode).toBe(0);
      const combined = `${waitResult.stdout}\n${waitResult.stderr}`;
      expect(combined).toContain("looks great");

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 7.2 SIGKILL submitter, deny from UI, wait collects deny ───────────────
  test("7.2 SIGKILL submitter, deny with feedback, wait exits 1 with feedback", async () => {
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

      submitHandle.kill("SIGKILL");
      await submitHandle.waitForExit();

      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "too vague, needs error handling section" }),
      });

      const waitResult = await runCli(["wait"], { env: env(), timeoutMs: 15_000 });
      // ADR: denied verdict → exit 1
      expect(waitResult.exitCode).toBe(1);
      const combined = `${waitResult.stdout}\n${waitResult.stderr}`;
      expect(combined).toContain("too vague");

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 7.3 wait when idle → exits promptly, does not block forever ───────────
  test("7.3 plannotator wait when idle: does not block forever, exits with a clear message", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);

      const waitResult = await runCli(["wait"], {
        env: env(),
        timeoutMs: 15_000,
      });
      // ADR: no active session → exit 2 (illegal-state) or exit 1 with "nothing" message
      expect([1, 2]).toContain(waitResult.exitCode);
      const combined = `${waitResult.stdout}\n${waitResult.stderr}`;
      expect(combined.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 7.4 wait while active — blocks until verdict ──────────────────────────
  test("7.4 plannotator wait while active blocks until verdict arrives", async () => {
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

      // Start a second waiter in the background
      const waitHandle = runCliBackground(["wait"], { env: env() });

      // Give both CLIs a moment to start waiting
      await new Promise((r) => setTimeout(r, 500));

      // Approve via HTTP
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "approved", annotations: [] }),
      });

      // Both the submitter and the waiter should receive the verdict
      const [submitResult, waitResult] = await Promise.all([
        submitHandle.waitForExit(),
        waitHandle.waitForExit(),
      ]);

      // ADR: verdict broadcast - both the original submitter and any plannotator wait
      // callers receive the approved verdict.
      expect(submitResult.exitCode).toBe(0);
      expect(waitResult.exitCode).toBe(0);

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 7.5 wait --json outputs a valid JSON object ───────────────────────────
  test("7.5 plannotator wait --json produces valid JSON on stdout", async () => {
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

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [] }),
      });

      const [, waitResult] = await Promise.all([
        submitHandle.waitForExit(),
        runCli(["wait", "--json"], { env: env(), timeoutMs: 15_000 }),
      ]);

      expect(waitResult.exitCode).toBe(0);
      const parsed = JSON.parse(waitResult.stdout.trim()) as Record<string, unknown>;
      expect(typeof parsed.approved).toBe("boolean");
      expect(parsed.approved).toBe(true);
      expect("feedback" in parsed).toBe(true);
      expect("mode" in parsed).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);
});
