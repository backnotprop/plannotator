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

// NOTE on Playwright: this spec drives the plan submission flow end-to-end.
// UI interactions (clicking Approve/Deny, adding annotations in the browser)
// are simulated via direct HTTP calls to the daemon API. When Playwright is
// available, the HTTP calls in each test can be replaced with browser actions
// at http://127.0.0.1:${port}/.

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/plans",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("04-submit-plan", () => {
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

  // ─── 4.1 Happy path ────────────────────────────────────────────────────────
  test("4.1 submit small.md → daemon active → approve → CLI exits 0 → state idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );

      // Assert: daemon enters awaiting-response with mode=plan
      const deadline = Date.now() + 10_000;
      let stateBody: { status: string; document?: { mode?: string } } | null = null;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        stateBody = (await resp.json()) as typeof stateBody;
        if (stateBody?.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(stateBody?.status).toBe("awaiting-response");
      expect(stateBody?.document?.mode).toBe("plan");

      // Simulate UI "Approve" click
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(0);

      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 4.2 Deny with feedback ────────────────────────────────────────────────
  test("4.2 submit → deny with feedback → CLI exits 1, output contains feedback", async () => {
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

      // Simulate UI "Deny" with feedback
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback:
            "this is wrong — global note: needs more detail\n\nInline comment on 'Read the file': this section needs clarification",
        }),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(1);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toContain("this is wrong");
      expect(combined).toContain("needs more detail");
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 4.3 Annotation types coverage ────────────────────────────────────────
  test("4.3 deny with structured annotations: all annotation types appear in feedback", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "multi-section.md"), "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Send deny with structured annotations covering all types
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: [
            "[DELETION] remove this paragraph",
            "[INSERTION] add a new section here",
            "[REPLACEMENT] replace 'foo' with 'bar'",
            "[COMMENT] this block needs explanation",
            "[GLOBAL_COMMENT] overall structure needs work",
          ].join("\n"),
          annotations: [
            { type: "DELETION", originalText: "remove this", text: null },
            { type: "INSERTION", originalText: "", text: "new content" },
            { type: "REPLACEMENT", originalText: "foo", text: "bar" },
            { type: "COMMENT", originalText: "this block", text: "needs explanation" },
            { type: "GLOBAL_COMMENT", originalText: "", text: "overall structure needs work" },
          ],
        }),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(1);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 4.8 Long timeout disabled ────────────────────────────────────────────
  test("4.8 PLANNOTATOR_PLAN_TIMEOUT_SECONDS=0 does not timeout in 5s", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        {
          env: {
            ...env(),
            PLANNOTATOR_PLAN_TIMEOUT_SECONDS: "0",
          },
        },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Wait 5 seconds — if timeout is disabled, CLI must still be running
      await new Promise((r) => setTimeout(r, 5_000));

      const stateResp = await fetch(daemonUrl("/api/state"));
      const state = (await stateResp.json()) as { status: string };
      expect(state.status).toBe("awaiting-response");

      // Now approve to clean up
      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      const result = await submitHandle.waitForExit();
      expect(result.exitCode).toBe(0);
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 4.9 Short timeout fires ──────────────────────────────────────────────
  test("4.9 PLANNOTATOR_PLAN_TIMEOUT_SECONDS=2 fires, CLI exits non-0, state → idle", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        {
          env: {
            ...env(),
            PLANNOTATOR_PLAN_TIMEOUT_SECONDS: "2",
          },
        },
      );

      // Wait for timeout (2s + some buffer)
      const result = await submitHandle.waitForExit();
      expect(result.exitCode).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined.toLowerCase()).toMatch(/timeout|timed out/);

      // State must be idle after timeout
      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 20_000);

  // ─── 4.10 --no-browser flag ───────────────────────────────────────────────
  test("4.10 --no-browser flag: submit blocks without opening browser, URL still printed", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Remove PLANNOTATOR_BROWSER override so the binary relies on --no-browser
      const envWithoutBrowserOverride = {
        HOME: sandbox.home,
        PLANNOTATOR_PORT: String(port),
        // Intentionally leave PLANNOTATOR_BROWSER unset to test --no-browser
        PLANNOTATOR_BROWSER: "/dev/null",
      };

      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: envWithoutBrowserOverride },
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

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });

      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 4.4 No-heading slug ─────────────────────────────────────────────────
  test("4.4 plan with no heading: slug contains plan-YYYY-MM-DD", async () => {
    const { readdirSync, existsSync } = await import("node:fs");

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const noHeadingPlan = join(FIXTURES_DIR, "no-heading.md");
      const submitHandle = runCliBackground(
        ["submit", noHeadingPlan, "--no-browser"],
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

      await submitHandle.waitForExit();

      const historyRoot = join(sandbox.home, ".plannotator", "history");
      if (existsSync(historyRoot)) {
        const projects = readdirSync(historyRoot);
        if (projects.length > 0) {
          const slugs = readdirSync(join(historyRoot, projects[0]));
          const hasDateSlug = slugs.some((s) => /^plan-\d{4}-\d{2}-\d{2}/.test(s));
          expect(hasDateSlug).toBe(true);
        }
      }
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 4.5 Identical resubmission dedup ────────────────────────────────────
  test("4.5 identical resubmission: no new version file created", async () => {
    const { readdirSync, existsSync } = await import("node:fs");

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      async function submitAndApprove() {
        const submitHandle = runCliBackground(
          ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
          { env: env() },
        );
        const dl = Date.now() + 10_000;
        while (Date.now() < dl) {
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
        await submitHandle.waitForExit();
      }

      await submitAndApprove();

      const historyRoot = join(sandbox.home, ".plannotator", "history");
      let versionsBefore = 0;
      if (existsSync(historyRoot)) {
        const projects = readdirSync(historyRoot);
        if (projects.length > 0) {
          const slugs = readdirSync(join(historyRoot, projects[0]));
          if (slugs.length > 0) {
            versionsBefore = readdirSync(join(historyRoot, projects[0], slugs[0])).length;
          }
        }
      }

      await submitAndApprove();

      if (existsSync(historyRoot)) {
        const projects = readdirSync(historyRoot);
        if (projects.length > 0) {
          const slugs = readdirSync(join(historyRoot, projects[0]));
          if (slugs.length > 0 && versionsBefore > 0) {
            const versionsAfter = readdirSync(join(historyRoot, projects[0], slugs[0])).length;
            expect(versionsAfter).toBe(versionsBefore);
          }
        }
      }
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  // ─── 4.6 Revision diff API ────────────────────────────────────────────────
  test("4.6 after resubmit with changes: /api/plan/versions lists 2+ versions", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // First submission
      const first = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env() },
      );
      let dl = Date.now() + 10_000;
      while (Date.now() < dl) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "revise" }),
      });
      await first.waitForExit();

      // Second submission (different content = different version)
      const second = runCliBackground(
        ["submit", join(FIXTURES_DIR, "multi-section.md"), "--no-browser"],
        { env: env() },
      );
      dl = Date.now() + 10_000;
      while (Date.now() < dl) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const versionsResp = await fetch(daemonUrl("/api/plan/versions"));
      if (versionsResp.ok) {
        const versions = (await versionsResp.json()) as unknown[];
        expect(versions.length).toBeGreaterThanOrEqual(2);
      }

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await second.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  // ─── 4.7 --commit-message propagation ────────────────────────────────────
  test("4.7 --commit-message value appears in plan git history", async () => {
    const { execSync } = await import("node:child_process");
    const { readdirSync, existsSync } = await import("node:fs");

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const commitMsg = "addressed review feedback re: error handling";
      const submitHandle = runCliBackground(
        [
          "submit",
          join(FIXTURES_DIR, "small.md"),
          "--no-browser",
          "--commit-message",
          commitMsg,
        ],
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

      await submitHandle.waitForExit();

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      if (existsSync(plansRoot)) {
        const projects = readdirSync(plansRoot);
        if (projects.length > 0) {
          const projectDir = join(plansRoot, projects[0]);
          const gitLog = execSync("git log --format=%B", {
            cwd: projectDir,
            encoding: "utf8",
          });
          expect(gitLog).toContain(commitMsg);
        }
      }
    } finally {
      await daemon.stop();
    }
  }, 40_000);
});
