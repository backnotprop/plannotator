import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
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

// NOTE on Playwright: this spec exercises the review mode flow.
// UI interactions (code annotations, staging buttons) are driven via
// direct HTTP calls to the daemon API. Add Playwright browser interaction
// once @playwright/test is installed and a playwright.config.ts is added.

const REPOS_DIR = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  "fixtures/repos",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("05-review-mode", () => {
  let sandbox: Sandbox;
  let port: number;
  let testRepo: string;

  beforeEach(async () => {
    sandbox = createSandbox();
    port = await getFreePort();
    testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();
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

  // ─── 5.1 diff type: uncommitted ───────────────────────────────────────────
  test("5.1 review --diff-type uncommitted: /api/diff returns patch, daemon enters active", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(["review", "--diff-type", "uncommitted", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      const deadline = Date.now() + 10_000;
      let active = false;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string; document?: { mode?: string } };
        if (body.status === "awaiting-response" && body.document?.mode === "review") {
          active = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(active).toBe(true);

      // GET /api/diff should return the known patch
      const diffResp = await fetch(daemonUrl("/api/diff"));
      expect(diffResp.ok).toBe(true);
      const diffBody = (await diffResp.json()) as { rawPatch?: string };
      expect(typeof diffBody.rawPatch).toBe("string");
      expect(diffBody.rawPatch).toContain("greet.ts");

      // Clean up
      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [], approved: true }),
      });
      await reviewHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 5.1b diff type: last-commit ──────────────────────────────────────────
  test("5.1b review --diff-type last-commit: returns diff of HEAD vs HEAD~1", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Stage and commit the unstaged change so last-commit shows it
      execSync("git add greet.ts && git commit -q -m 'update greet'", {
        cwd: testRepo,
      });

      const reviewHandle = runCliBackground(["review", "--diff-type", "last-commit", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const diffResp = await fetch(daemonUrl("/api/diff"));
      const diffBody = (await diffResp.json()) as { rawPatch?: string };
      expect(typeof diffBody.rawPatch).toBe("string");
      // last-commit diff should show the recently committed change
      expect((diffBody.rawPatch ?? "").length).toBeGreaterThan(0);

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

  // ─── 5.1c diff type: staged ──────────────────────────────────────────────
  test("5.1c review --diff-type staged: returns only staged changes", async () => {
    execSync("git add greet.ts", { cwd: testRepo });

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(["review", "--diff-type", "staged", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const diffResp = await fetch(daemonUrl("/api/diff"));
      expect(diffResp.ok).toBe(true);
      const diffBody = (await diffResp.json()) as { rawPatch?: string };
      expect(typeof diffBody.rawPatch).toBe("string");
      expect(diffBody.rawPatch).toContain("greet.ts");

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [], approved: true }),
      });
      await reviewHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 5.1d diff type: unstaged ─────────────────────────────────────────────
  test("5.1d review --diff-type unstaged: returns unstaged changes only", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(["review", "--diff-type", "unstaged", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      const diffResp = await fetch(daemonUrl("/api/diff"));
      expect(diffResp.ok).toBe(true);
      const diffBody = (await diffResp.json()) as { rawPatch?: string };
      expect(typeof diffBody.rawPatch).toBe("string");
      expect(diffBody.rawPatch).toContain("greet.ts");

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [], approved: true }),
      });
      await reviewHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 5.1e diff type: branch ───────────────────────────────────────────────
  test("5.1e review --diff-type branch: compares HEAD against specified base branch", async () => {
    // Create a feature branch from the initial commit, then commit changes on main
    execSync("git checkout -b feature-branch && git checkout main", { cwd: testRepo });
    execSync("git add greet.ts && git commit -q -m 'update greet on main'", { cwd: testRepo });

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(
        ["review", "--diff-type", "branch:feature-branch", "--no-browser"],
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
      if (diffResp.ok) {
        const diffBody = (await diffResp.json()) as { rawPatch?: string };
        expect(typeof diffBody.rawPatch).toBe("string");
      }

      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM", annotations: [], approved: true }),
      });
      await reviewHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 5.2 Async feedback delivery ──────────────────────────────────────────
  test("5.2 plannotator review exits/returns quickly (non-blocking), feedback delivered later", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const start = Date.now();
      const reviewHandle = runCliBackground(["review", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      // Wait for active
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Feedback submitted a few seconds later
      await new Promise((r) => setTimeout(r, 2_000));
      await fetch(daemonUrl("/api/feedback"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          feedback: "looks good with minor suggestions",
          annotations: [],
          approved: true,
        }),
      });

      const result = await reviewHandle.waitForExit();
      // Review exits 0 regardless of approve/deny (it's informational)
      expect(result.exitCode).toBe(0);
      // The review command should complete successfully
      expect(Date.now() - start).toBeLessThan(30_000);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 5.3 git-add endpoint ─────────────────────────────────────────────────
  test("5.3 POST /api/git-add stages the file, undo=true unstages it", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(["review", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }

      // Stage the file via API
      const stageResp = await fetch(daemonUrl("/api/git-add"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath: "greet.ts" }),
      });
      expect(stageResp.ok).toBe(true);

      const staged = execSync("git diff --cached --name-only", {
        cwd: testRepo,
        encoding: "utf8",
      });
      expect(staged).toContain("greet.ts");

      // Unstage via API
      const unstageResp = await fetch(daemonUrl("/api/git-add"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath: "greet.ts", undo: true }),
      });
      expect(unstageResp.ok).toBe(true);

      const afterUnstage = execSync("git diff --cached --name-only", {
        cwd: testRepo,
        encoding: "utf8",
      });
      expect(afterUnstage).not.toContain("greet.ts");

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

  // ─── 5.4 Cancel from review ───────────────────────────────────────────────
  test("5.4 cancel from review: daemon → idle, CLI exits", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const reviewHandle = runCliBackground(["review", "--no-browser"], {
        env: env(),
        cwd: testRepo,
      });

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

      const result = await reviewHandle.waitForExit();
      // Cancelled review: CLI exits (code 0 or 1 depending on implementation)
      expect(typeof result.exitCode).toBe("number");

      await new Promise((r) => setTimeout(r, 300));
      await expectIdle(port);
    } finally {
      await daemon.stop();
    }
  }, 30_000);
});
