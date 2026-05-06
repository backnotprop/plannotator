import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/markdown",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("06-annotate-mode", () => {
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

  const annotateTarget = join(FIXTURES_DIR, "annotate-target.md");

  // ─── 6.1 Basic annotate mode ──────────────────────────────────────────────
  test("6.1 plannotator annotate <file>: daemon enters active with mode=annotate, /api/plan returns file content", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateHandle = runCliBackground(
        ["annotate", annotateTarget, "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      let stateBody: { status: string; document?: { mode?: string } } | null = null;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        stateBody = (await resp.json()) as typeof stateBody;
        if (stateBody?.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(stateBody?.status).toBe("awaiting-response");
      expect(stateBody?.document?.mode).toBe("annotate");

      // /api/plan should return the file content
      const planResp = await fetch(daemonUrl("/api/plan"));
      expect(planResp.ok).toBe(true);
      const planBody = (await planResp.json()) as { plan?: string; mode?: string; filePath?: string };
      expect(planBody.mode).toBe("annotate");
      expect(typeof planBody.plan).toBe("string");
      expect(planBody.plan).toContain("Project Charter");

      // Deliver feedback to clean up
      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await annotateHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 6.2 @ prefix stripped ────────────────────────────────────────────────
  test("6.2 @-prefixed file path: @ is stripped, file loads correctly", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const atPrefixedPath = `@${annotateTarget}`;
      const annotateHandle = runCliBackground(
        ["annotate", atPrefixedPath, "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string; document?: { mode?: string } };
        if (body.status === "awaiting-response" && body.document?.mode === "annotate") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const planResp = await fetch(daemonUrl("/api/plan"));
      const planBody = (await planResp.json()) as { plan?: string };
      expect(typeof planBody.plan).toBe("string");
      expect(planBody.plan?.length).toBeGreaterThan(0);

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await annotateHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 6.3 Feedback delivery ────────────────────────────────────────────────
  test("6.3 submit annotations → feedback delivered → CLI exits", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateHandle = runCliBackground(
        ["annotate", annotateTarget, "--no-browser"],
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
        body: JSON.stringify({
          feedback: "annotation note: the goals section needs priority ordering",
          annotations: [
            {
              type: "COMMENT",
              originalText: "Ship the new pricing page",
              text: "needs deadline date",
            },
          ],
        }),
      });

      const result = await annotateHandle.waitForExit();
      // Annotate feedback → exit 0 (informational, not approve/deny)
      expect(result.exitCode).toBe(0);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 6.4 Cancel annotation ────────────────────────────────────────────────
  test("6.4 cancel annotation: daemon → idle, cancel message in output", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateHandle = runCliBackground(
        ["annotate", annotateTarget, "--no-browser"],
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

      const result = await annotateHandle.waitForExit();
      // Cancel delivers exact message including the file path
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toContain(`Annotation of ${annotateTarget} cancelled by user.`);

      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 6.5 Non-existent file ────────────────────────────────────────────────
  test("6.5 non-existent file: exits non-zero with clear error, daemon stays idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await expectIdle(port);

      const result = await runCli(
        ["annotate", "/tmp/this-file-does-not-exist-plannotator-e2e.md", "--no-browser"],
        { env: env(), timeoutMs: 10_000 },
      );
      expect(result.exitCode).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.length).toBeGreaterThan(0);

      // Daemon must remain idle — bad file must not corrupt state
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  });

  // ─── 6.6 Absolute paths work ──────────────────────────────────────────────
  test("6.6 absolute path outside cwd: file loads correctly", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Run from /tmp but annotate an absolute path in the fixtures dir
      const annotateHandle = runCliBackground(
        ["annotate", annotateTarget, "--no-browser"],
        { env: env(), cwd: "/tmp" },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("awaiting-response");

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await annotateHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
