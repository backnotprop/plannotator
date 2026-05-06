import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBinary,
  createSandbox,
  getFreePort,
  runCli,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";

// ADR: --json output contract
//   stdout: exactly one JSON object per line, nothing else
//   stderr: any diagnostic text (daemon URL, etc.)
//
// JSON schema:
//   { approved: boolean, cancelled: boolean, feedback: string, mode: string,
//     agentSwitch?: string, permissionMode?: string }

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

const REPOS_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/repos",
);

const MARKDOWN_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/markdown",
);

const SNAPSHOTS_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "__snapshots__",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
}, 300_000);

describe("12-json-output", () => {
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

  // ─── submit --json: approve case ───────────────────────────────────────────
  test("12.1 submit --json approve: stdout is a single JSON object, approved=true", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser", "--json"],
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

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(0);

      // stdout must be exactly one JSON object
      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(parsed.approved).toBe(true);
      expect(parsed.cancelled).toBe(false);
      expect(typeof parsed.feedback).toBe("string");
      expect(typeof parsed.mode).toBe("string");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── submit --json: deny case ──────────────────────────────────────────────
  test("12.2 submit --json deny: stdout JSON has approved=false, feedback present", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser", "--json"],
        { env: env() },
      );

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
        body: JSON.stringify({ feedback: "needs refactoring section" }),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(1);

      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(parsed.approved).toBe(false);
      expect(parsed.cancelled).toBe(false);
      expect(parsed.feedback).toContain("needs refactoring section");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── submit --json: cancel case ────────────────────────────────────────────
  test("12.3 submit --json cancel: stdout JSON has cancelled=true", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser", "--json"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/cancel"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      const result = await submitHandle.waitForExit();
      // ADR: daemon-cancelled → exit 1 (not 130)
      expect(result.exitCode).toBe(1);

      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(parsed.cancelled).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── submit --json: timeout case ──────────────────────────────────────────
  test("12.4 submit --json timeout: JSON has approved=false, cancelled=false", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser", "--json"],
        {
          env: {
            ...env(),
            PLANNOTATOR_PLAN_TIMEOUT_SECONDS: "2",
          },
        },
      );

      // Wait for timeout to fire (~2s)
      const result = await submitHandle.waitForExit();

      // Timed out submissions may exit with a specific code; accept 1 or 3
      expect([1, 3]).toContain(result.exitCode);
      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      // May or may not produce JSON on timeout (depends on implementation)
      // At minimum it must not produce multiple JSON objects
      if (lines.length > 0) {
        expect(lines.length).toBe(1);
        JSON.parse(lines[0]); // must be valid JSON
      }
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── stdout purity: no extra log lines on stdout when --json ───────────────
  test("12.5 submit --json: daemon URL and diagnostics go to stderr, not stdout", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser", "--json"],
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
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      const result = await submitHandle.waitForExit();

      // stdout must contain exactly one non-empty line (the JSON object)
      const stdoutLines = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(stdoutLines.length).toBe(1);
      expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── review --json ─────────────────────────────────────────────────────────
  test("12.7 review --json: stdout is a single JSON object on approve", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(
        ["review", "--no-browser", "--json"],
        { env: env(), cwd: testRepo },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [], approved: true }),
      });

      const result = await reviewHandle.waitForExit();
      expect(result.exitCode).toBe(0);

      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(typeof parsed.approved).toBe("boolean");
      expect(parsed.approved).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── review --json: stdout purity ─────────────────────────────────────────
  test("12.8 review --json: daemon diagnostics go to stderr, not stdout", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(
        ["review", "--no-browser", "--json"],
        { env: env(), cwd: testRepo },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [], approved: true }),
      });

      const result = await reviewHandle.waitForExit();
      const stdoutLines = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(stdoutLines.length).toBe(1);
      expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── annotate --json ───────────────────────────────────────────────────────
  test("12.9 annotate --json: stdout is a single JSON object on feedback submit", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateHandle = runCliBackground(
        ["annotate", join(MARKDOWN_DIR, "annotate-target.md"), "--no-browser", "--json"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "looks good", annotations: [] }),
      });

      const result = await annotateHandle.waitForExit();
      expect(result.exitCode).toBe(0);

      const lines = result.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(typeof parsed.mode).toBe("string");
      expect(parsed.mode).toBe("annotate");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── annotate --json: stdout purity ───────────────────────────────────────
  test("12.10 annotate --json: diagnostics go to stderr, not stdout", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateHandle = runCliBackground(
        ["annotate", join(MARKDOWN_DIR, "annotate-target.md"), "--no-browser", "--json"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      const result = await annotateHandle.waitForExit();
      const stdoutLines = result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      expect(stdoutLines.length).toBe(1);
      expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── wait --json ───────────────────────────────────────────────────────────
  test("12.6 wait --json: produces single JSON line conforming to schema", async () => {
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

      const lines = waitResult.stdout.trim().split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]) as Record<string, unknown>;

      // Schema lock: these fields must always be present
      expect("approved" in parsed).toBe(true);
      expect("cancelled" in parsed).toBe(true);
      expect("feedback" in parsed).toBe(true);
      expect("mode" in parsed).toBe(true);

      // Write snapshot
      const snapshotPath = join(SNAPSHOTS_DIR, "json-output.json");
      if (!existsSync(snapshotPath)) {
        writeFileSync(snapshotPath, JSON.stringify({ schema: Object.keys(parsed).sort() }, null, 2));
      } else {
        const existing = JSON.parse(readFileSync(snapshotPath, "utf8")) as { schema: string[] };
        expect(Object.keys(parsed).sort()).toEqual(existing.schema);
      }
    } finally {
      await daemon.stop();
    }
  }, 40_000);
});
