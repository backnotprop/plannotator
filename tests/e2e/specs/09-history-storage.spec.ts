import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// ADR: plan storage layout
//   ${HOME}/.plannotator/plans/{project}/{slug}.md   — plan file
//   {project} dir is a git repo
//   slug = {heading-kebab}-YYYY-MM-DD, or plan-YYYY-MM-DD if no heading

const FIXTURES_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/plans",
);

const REPOS_DIR = resolve(
  fileURLToPath(new URL("../", import.meta.url)),
  "fixtures/repos",
);

let binary: string;

beforeAll(async () => {
  binary = await buildBinary();
}, 300_000);

describe("09-history-storage", () => {
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

  async function submitAndApprove(plan: string, commitMessage?: string): Promise<void> {
    const args = ["submit", plan, "--no-browser"];
    if (commitMessage) {
      args.push("--commit-message", commitMessage);
    }
    const submitHandle = runCliBackground(args, { env: env() });

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
  }

  // ─── 9.1 plan directory structure ─────────────────────────────────────────
  test("9.1 approved plan creates git repo with slug.md in plans/{project}/", async () => {
    // Create a temp git repo to serve as cwd (project detection from git root)
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: { ...env(), HOME: sandbox.home }, cwd: testRepo },
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
      expect(existsSync(plansRoot)).toBe(true);

      const projects = readdirSync(plansRoot);
      expect(projects.length).toBeGreaterThan(0);

      const projectDir = join(plansRoot, projects[0]);
      // Must be a git repo
      expect(existsSync(join(projectDir, ".git"))).toBe(true);

      // Must contain a slug.md file
      const files = readdirSync(projectDir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBeGreaterThan(0);

      // Slug must follow pattern: {heading}-YYYY-MM-DD
      const today = new Date().toISOString().slice(0, 10);
      expect(files.some((f) => f.endsWith(`${today}.md`))).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 9.2 git log contains commit-message value ────────────────────────────
  test("9.2 git log in plans dir contains commit-message string", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const commitMsg = "addressed error-handling review feedback";
      await submitAndApprove(join(FIXTURES_DIR, "small.md"), commitMsg);

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      expect(projects.length).toBeGreaterThan(0);

      const projectDir = join(plansRoot, projects[0]);
      const gitLog = execSync("git log --format=%B", {
        cwd: projectDir,
        encoding: "utf8",
      });
      expect(gitLog).toContain(commitMsg);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 9.3 project name detection: inside a git repo ────────────────────────
  test("9.3 project name derives from git repo root name", async () => {
    const testRepo = execSync(`bash "${join(REPOS_DIR, "make-repo.sh")}"`, {
      encoding: "utf8",
    }).trim();

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env(), cwd: testRepo },
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
      const projects = readdirSync(plansRoot);
      // Project name should be derived from the repo root directory name
      // (sanitized, lowercase, hyphens)
      expect(projects.length).toBeGreaterThan(0);
      const projectName = projects[0];
      // The test repo is named something like plannotator-e2e-repo.XXXXX
      expect(projectName).toMatch(/plannotator/);
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 9.5 deny-resubmit-approve cycle in git history ──────────────────────
  test("9.5 deny-resubmit-approve cycle produces correct git history", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      // Submit and deny
      const firstSubmit = runCliBackground(
        ["submit", join(FIXTURES_DIR, "revision-base.md"), "--no-browser", "--commit-message", "initial plan"],
        { env: env() },
      );
      let deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const resp = await fetch(daemonUrl("/api/state"));
        const body = (await resp.json()) as { status: string };
        if (body.status === "awaiting-response") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await fetch(daemonUrl("/api/deny"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "needs more sections" }),
      });
      await firstSubmit.waitForExit();

      // Resubmit revised plan
      const secondSubmit = runCliBackground(
        ["submit", join(FIXTURES_DIR, "revision-revised.md"), "--no-browser", "--commit-message", "addressed feedback: added sections"],
        { env: env() },
      );
      deadline = Date.now() + 10_000;
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
      await secondSubmit.waitForExit();

      // Check git log
      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      const projectDir = join(plansRoot, projects[0]);
      const gitLog = execSync("git log --format=%B", {
        cwd: projectDir,
        encoding: "utf8",
      });

      expect(gitLog).toContain("initial plan");
      expect(gitLog).toContain("addressed feedback");
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  // ─── 9.4 Project name detection: cwd NOT inside git repo ─────────────────
  test("9.4 project name falls back to cwd directory name when not in a git repo", async () => {
    const { mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nonGitDir = join(tmpdir(), `plannotator-e2e-nongit-${Date.now()}`);
    mkdirSync(nonGitDir, { recursive: true });

    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const submitHandle = runCliBackground(
        ["submit", join(FIXTURES_DIR, "small.md"), "--no-browser"],
        { env: env(), cwd: nonGitDir },
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
        expect(projects.length).toBeGreaterThan(0);
        // Project name should be derived from the non-git directory name
        const lastName = nonGitDir.split("/").pop() ?? "";
        const sanitized = lastName.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
        expect(projects.some((p) => p.includes(sanitized.slice(0, 10)))).toBe(true);
      }
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 9.6 Draft persistence via /api/draft ─────────────────────────────────
  test("9.6 annotation draft saved to /api/draft persists between requests", async () => {
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

      const draft = { annotations: [{ id: "a1", type: "COMMENT", text: "test note", originalText: "foo" }] };

      // Save draft
      const saveResp = await fetch(daemonUrl("/api/draft"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      expect(saveResp.ok).toBe(true);

      // Retrieve draft
      const getResp = await fetch(daemonUrl("/api/draft"));
      expect(getResp.ok).toBe(true);
      const retrieved = (await getResp.json()) as { annotations?: unknown[] };
      expect(Array.isArray(retrieved.annotations)).toBe(true);
      expect((retrieved.annotations ?? []).length).toBeGreaterThan(0);

      await fetch(daemonUrl("/api/approve"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ feedback: "", annotations: [] }),
      });
      await submitHandle.waitForExit();
    } finally {
      await daemon.stop();
    }
  }, 40_000);

  // ─── 9.7 Obsidian integration smoke test ──────────────────────────────────
  test("9.7 /api/obsidian/vaults endpoint responds without crashing daemon", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      const resp = await fetch(daemonUrl("/api/obsidian/vaults"));
      // Endpoint must exist (200 or 404 is OK; crash/500 is not)
      expect([200, 404]).toContain(resp.status);
      if (resp.ok) {
        const body = (await resp.json()) as unknown;
        expect(Array.isArray(body)).toBe(true);
      }
    } finally {
      await daemon.stop();
    }
  });

  // ─── 9.x plan-no-heading slug fallback ────────────────────────────────────
  test("9.4 plan with no heading uses fallback slug plan-YYYY-MM-DD", async () => {
    const daemon = await startDaemon({ port, home: sandbox.home, binary });
    try {
      await submitAndApprove(join(FIXTURES_DIR, "plan-no-heading.md"));

      const plansRoot = join(sandbox.home, ".plannotator", "plans");
      const projects = readdirSync(plansRoot);
      const projectDir = join(plansRoot, projects[0]);
      const files = readdirSync(projectDir).filter((f) => f.endsWith(".md"));

      const today = new Date().toISOString().slice(0, 10);
      // Should have a file starting with "plan-" (fallback slug)
      expect(files.some((f) => f.startsWith("plan-") && f.includes(today))).toBe(true);
    } finally {
      await daemon.stop();
    }
  }, 40_000);
});
