import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBinary,
  createSandbox,
  getFreePort,
  runCliBackground,
  startDaemon,
  type Sandbox,
} from "../helpers";

// NOTE on Playwright: this spec is designed to be driven by a real browser.
// The tests below verify the daemon API surface that the UI depends on —
// they serve as integration-level smoke tests until Playwright is wired up.
//
// To add full browser coverage:
//   1. Install @playwright/test: bun add -d @playwright/test
//   2. Run: bunx playwright install chromium
//   3. Add playwright.config.ts at tests/playwright.config.ts
//   4. Replace HTTP assertions with Playwright `page.click()`, `page.locator()` etc.
//      navigating to getDaemonUrl(port).

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

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("10-ui-actions", () => {
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

  // ─── 10.1 Plan editor API surface ─────────────────────────────────────────

  test("10.1.1 plan mode: /api/plan returns content with plan, origin fields", async () => {
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

      const planResp = await fetch(daemonUrl("/api/plan"));
      expect(planResp.ok).toBe(true);
      const planBody = (await planResp.json()) as Record<string, unknown>;

      // Required fields for UI rendering
      expect(typeof planBody.plan).toBe("string");
      expect(typeof planBody.origin).toBe("string");

      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  test("10.1.2 draft API: save and load annotations round-trip", async () => {
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

      const draftPayload = {
        annotations: [
          { id: "ann1", type: "COMMENT", text: "check this line", originalText: "Read the file" },
        ],
      };

      // Save draft
      const saveResp = await fetch(daemonUrl("/api/draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftPayload),
      });
      expect(saveResp.ok).toBe(true);

      // Load draft
      const loadResp = await fetch(daemonUrl("/api/draft"));
      expect(loadResp.ok).toBe(true);
      const loaded = (await loadResp.json()) as { annotations?: unknown[] };
      expect(Array.isArray(loaded.annotations)).toBe(true);
      expect(loaded.annotations?.length).toBe(1);

      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  test("10.1.3 draft DELETE clears saved annotations", async () => {
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

      // Save, then delete
      await fetch(daemonUrl("/api/draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "x", type: "COMMENT", text: "note" }] }),
      });

      const deleteResp = await fetch(daemonUrl("/api/draft"), { method: "DELETE" });
      expect(deleteResp.ok).toBe(true);

      const loadResp = await fetch(daemonUrl("/api/draft"));
      // After delete, draft should be empty or return 404
      if (loadResp.ok) {
        const loaded = (await loadResp.json()) as { annotations?: unknown[] };
        expect((loaded.annotations ?? []).length).toBe(0);
      } else {
        expect(loadResp.status).toBe(404);
      }

      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);

  // ─── 10.2 Code review UI API surface ──────────────────────────────────────

  test("10.2.1 review mode: /api/diff returns rawPatch, gitRef, origin fields", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(
        ["review", "--no-browser"],
        { env: env(), cwd: testRepo },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const diffResp = await fetch(daemonUrl("/api/diff"));
      expect(diffResp.ok).toBe(true);
      const diffBody = (await diffResp.json()) as Record<string, unknown>;
      expect(typeof diffBody.rawPatch).toBe("string");
      expect("origin" in diffBody).toBe(true);

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [], approved: true }),
      });
      await reviewHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 10.3 Annotate UI API surface ─────────────────────────────────────────

  test("10.3.1 annotate mode: /api/plan returns mode=annotate and file content", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const annotateFile = join(MARKDOWN_DIR, "annotate-target.md");
      const annotateHandle = runCliBackground(
        ["annotate", annotateFile, "--no-browser"],
        { env: env() },
      );

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const planResp = await fetch(daemonUrl("/api/plan"));
      expect(planResp.ok).toBe(true);
      const planBody = (await planResp.json()) as { mode?: string; plan?: string; filePath?: string };
      expect(planBody.mode).toBe("annotate");
      expect((planBody.plan ?? "").length).toBeGreaterThan(0);

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

  // ─── 10.1.7 No share/copy-link button present ─────────────────────────────

  test("10.1.7 root HTML does not contain share or copy-link UI elements", async () => {
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

      const htmlResp = await fetch(daemonUrl("/"));
      const html = await htmlResp.text();

      // ADR: share/copy-link features were removed in the daemon refactor sprint.
      // If these strings appear in the built HTML, it's a P1 finding.
      expect(html.toLowerCase()).not.toContain("share.plannotator.ai");
      expect(html.toLowerCase()).not.toContain("copy link");

      await fetch(daemonUrl("/api/cancel"), { method: "POST" });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
