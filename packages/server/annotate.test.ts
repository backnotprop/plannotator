import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { liveAppDraftIdentity, runGuardedShutdown, startAnnotateServer } from "./annotate";
import { getServerConfig, loadConfig } from "./config";
import { deriveAnnotateHistorySlug } from "@plannotator/shared/annotate-history";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

describe("annotate server: /api/save-notes wiring", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  test("POST is served as JSON by the route, not the SPA HTML catch-all", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "test.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/save-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      const json = await response.json();
      expect(json).toHaveProperty("ok", true);
      expect(json.results).toEqual({});
    } finally {
      server.stop();
    }
  });

  test("an unmatched path still falls through to the SPA HTML", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "test.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/not-a-real-route`);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Plannotator");
    } finally {
      server.stop();
    }
  });

  test("/api/plan identifies the annotated file's repository, not the launch repository", async () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "plannotator-annotate-target-repo-"));
    const filePath = join(targetRoot, "specs", "refunds.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "# Refunds\n", "utf-8");
    execFileSync("git", ["init", "-q"], { cwd: targetRoot });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/payments-docs.git"], { cwd: targetRoot });

    const server = await startAnnotateServer({
      markdown: "# Refunds\n",
      filePath,
      htmlContent: MINIMAL_HTML,
    });
    try {
      const payload = (await (await fetch(`${server.url}/api/plan`)).json()) as {
        repoInfo?: { display: string };
      };
      expect(payload.repoInfo?.display).toBe("acme/payments-docs");
    } finally {
      server.stop();
      rmSync(targetRoot, { recursive: true, force: true });
    }
  });
});

describe("annotate server: /api/config favicon persistence", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;
  let savedDataDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    delete process.env.PLANNOTATOR_PORT;
    delete process.env.PLANNOTATOR_REMOTE;
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-annotate-config-test-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
    if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists the yellow favicon via POST /api/config and ignores unknown values", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "test.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const validResponse = await fetch(`${server.url}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favicon: "yellow" }),
      });
      expect(validResponse.status).toBe(200);
      expect(loadConfig().favicon).toBe("yellow");
      expect(getServerConfig(null).favicon).toBe("yellow");

      const invalidResponse = await fetch(`${server.url}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ favicon: "unknown" }),
      });
      expect(invalidResponse.status).toBe(200);
      expect(loadConfig().favicon).toBe("yellow");
      expect(getServerConfig(null).favicon).toBe("yellow");
    } finally {
      server.stop();
    }
  });
});

describe("annotate server: /api/share-html symlink containment", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  test("rejects a symlinked .html that escapes the document directory", async () => {
    const docDir = mkdtempSync(join(tmpdir(), "plannotator-sharehtml-"));
    const secretDir = mkdtempSync(join(tmpdir(), "plannotator-secret-"));
    const secretPath = join(secretDir, "secret.html");
    writeFileSync(secretPath, "SECRET_OUTSIDE_CONTENT", "utf-8");
    symlinkSync(secretPath, join(docDir, "evil.html"));
    const pagePath = join(docDir, "page.html");
    writeFileSync(pagePath, MINIMAL_HTML, "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: MINIMAL_HTML,
      renderHtml: true,
    });

    try {
      const response = await fetch(
        `${server.url}/api/share-html?path=${encodeURIComponent(join(docDir, "evil.html"))}`,
        { headers: { "X-Forwarded-For": "192.0.2.10" } },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("SECRET_OUTSIDE_CONTENT");
    } finally {
      server.stop();
    }
  });

});

describe("annotate server: local rendered-HTML root freshness", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;
  let savedHistoryFlag: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
    if (savedHistoryFlag === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistoryFlag;
  });

  const mintedProjects: string[] = [];
  function uniqueProject(label: string): string {
    const project = `_annotate_root_html_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mintedProjects.push(project);
    return project;
  }

  afterAll(() => {
    const historyDir = join(getPlannotatorDataDir(), "history");
    for (const project of mintedProjects) {
      rmSync(join(historyDir, project), { recursive: true, force: true });
    }
  });

  const page = (marker: string) => `<html><body>${marker}</body></html>`;
  const freshDocDir = (label: string) => realpathSync(mkdtempSync(join(tmpdir(), `plannotator-root-html-${label}-`)));

  test("/api/share-html shares the root document's current bytes after the file changes on disk", async () => {
    const pagePath = join(freshDocDir("share"), "page.html");
    writeFileSync(pagePath, page("STARTUP_VERSION"), "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("STARTUP_VERSION"),
      renderHtml: true,
      project: uniqueProject("share"),
    });

    try {
      writeFileSync(pagePath, page("REFRESHED_VERSION"), "utf-8");
      const refreshed = await (await fetch(
        `${server.url}/api/share-html?path=${encodeURIComponent(pagePath)}`,
      )).json() as { shareHtml: string };
      expect(refreshed.shareHtml).toContain("REFRESHED_VERSION");
      expect(refreshed.shareHtml).not.toContain("STARTUP_VERSION");

      unlinkSync(pagePath);
      const fallback = await (await fetch(`${server.url}/api/share-html`)).json() as { shareHtml: string };
      expect(fallback.shareHtml).toContain("STARTUP_VERSION");
    } finally {
      server.stop();
    }
  });

  test("/api/plan serves the root document's current bytes and recomputes the version diff against them", async () => {
    const pagePath = join(freshDocDir("plan"), "page.html");
    const project = uniqueProject("plan");
    type PlanPayload = {
      rawHtml?: string;
      previousPlan?: string | null;
      versionInfo?: { version: number };
      diffCurrent?: string;
      diffHtml?: string;
    };

    writeFileSync(pagePath, page("V1"), "utf-8");
    const seed = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("V1"),
      renderHtml: true,
      project,
    });
    seed.stop();

    writeFileSync(pagePath, page("V2"), "utf-8");
    const server = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("V2"),
      renderHtml: true,
      project,
    });
    const plan = async () => (await (await fetch(`${server.url}/api/plan`)).json()) as PlanPayload;

    try {
      const startup = await plan();
      expect(startup.rawHtml).toContain("V2");
      expect(startup.previousPlan).toBe(page("V1"));
      expect(startup.versionInfo?.version).toBe(2);
      expect(startup.diffHtml).toBeDefined();

      writeFileSync(pagePath, page("V3"), "utf-8");
      const reloaded = await plan();
      expect(reloaded.rawHtml).toContain("V3");
      expect(reloaded.rawHtml).not.toContain("V2");
      expect(reloaded.previousPlan).toBe(page("V1"));
      expect(reloaded.versionInfo?.version).toBe(2);
      expect(reloaded.diffCurrent).toBe(page("V3"));
      expect(reloaded.diffHtml).toContain("<ins");
      expect(reloaded.diffHtml).toContain("V3");
      expect(reloaded.diffHtml).not.toContain("V2");

      const refreshed = (await (await fetch(
        `${server.url}/api/doc?path=${encodeURIComponent(pagePath)}`,
      )).json()) as PlanPayload & { renderAs?: string };
      expect(refreshed.renderAs).toBe("html");
      expect(refreshed.rawHtml).toContain("V3");
      expect(refreshed.previousPlan).toBe(page("V1"));
      expect(refreshed.versionInfo?.version).toBe(2);
      expect(refreshed.diffHtml).toBe(reloaded.diffHtml);

      const siblingPath = join(dirname(pagePath), "sibling.html");
      writeFileSync(siblingPath, page("SIBLING"), "utf-8");
      const sibling = (await (await fetch(
        `${server.url}/api/doc?path=${encodeURIComponent(siblingPath)}`,
      )).json()) as PlanPayload;
      expect(sibling.rawHtml).toContain("SIBLING");
      expect(sibling.previousPlan).toBeUndefined();
      expect(sibling.diffHtml).toBeUndefined();

      const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as { versions: unknown[] };
      expect(versions.versions).toHaveLength(2);

      unlinkSync(pagePath);
      const fallback = await plan();
      expect(fallback.rawHtml).toContain("V2");
      expect(fallback.previousPlan).toBe(page("V1"));
      expect(fallback.diffHtml).toBeDefined();
    } finally {
      server.stop();
    }
  });

  async function seedTwoVersions(label: string): Promise<{ pagePath: string; project: string }> {
    const pagePath = join(freshDocDir(label), "page.html");
    const project = uniqueProject(label);
    writeFileSync(pagePath, page("V1"), "utf-8");
    const seed = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("V1"),
      renderHtml: true,
      project,
    });
    seed.stop();
    writeFileSync(pagePath, page("V2"), "utf-8");
    return { pagePath, project };
  }

  type FallbackPayload = { rawHtml?: string; previousPlan?: string | null; versionInfo?: { version: number }; diffHtml?: string };

  test("/api/plan falls back to the startup snapshot (with its version diff) when the root path becomes a directory", async () => {
    const { pagePath, project } = await seedTwoVersions("dir");
    const server = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("V2"),
      renderHtml: true,
      project,
    });
    try {
      unlinkSync(pagePath);
      mkdirSync(pagePath);
      const res = await fetch(`${server.url}/api/plan`);
      expect(res.status).toBe(200);
      const fallback = (await res.json()) as FallbackPayload;
      expect(fallback.rawHtml).toContain("V2");
      expect(fallback.previousPlan).toBe(page("V1"));
      expect(fallback.versionInfo?.version).toBe(2);
      expect(fallback.diffHtml).toBeDefined();

      const share = await fetch(`${server.url}/api/share-html`);
      expect(share.status).toBe(200);
      expect(((await share.json()) as { shareHtml: string }).shareHtml).toContain("V2");
    } finally {
      server.stop();
    }
  });

  const canRevokeRead = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  test.skipIf(!canRevokeRead)("/api/plan falls back to the startup snapshot when the root file is unreadable", async () => {
    const { pagePath, project } = await seedTwoVersions("perm");
    const server = await startAnnotateServer({
      markdown: "",
      filePath: pagePath,
      htmlContent: MINIMAL_HTML,
      rawHtml: page("V2"),
      renderHtml: true,
      project,
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    try {
      writeFileSync(pagePath, page("V3"), "utf-8");
      chmodSync(pagePath, 0o000);
      const res = await fetch(`${server.url}/api/plan`);
      expect(res.status).toBe(200);
      const fallback = (await res.json()) as FallbackPayload;
      expect(fallback.rawHtml).toContain("V2");
      expect(fallback.rawHtml).not.toContain("V3");
      expect(fallback.previousPlan).toBe(page("V1"));
      expect(fallback.diffHtml).toBeDefined();
      await fetch(`${server.url}/api/plan`);
      const rootWarnings = warnings.filter((w) => w.includes("could not read the HTML root"));
      expect(rootWarnings).toHaveLength(1);
      expect(rootWarnings[0]).toContain(pagePath);
    } finally {
      console.warn = originalWarn;
      chmodSync(pagePath, 0o644);
      server.stop();
    }
  });
});

describe("annotate server: source save", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  test("recreates a deleted single-file source on save", async () => {
    const docDir = mkdtempSync(join(tmpdir(), "plannotator-source-save-"));
    const sourcePath = join(docDir, "source.md");
    writeFileSync(sourcePath, "Before\r\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "Before\r\n",
      filePath: sourcePath,
      htmlContent: MINIMAL_HTML,
    });

    try {
      const planResponse = await fetch(`${server.url}/api/plan`);
      const plan = await planResponse.json() as { sourceSave?: { hash: string; mtimeMs: number; eol: "lf" | "crlf" | "mixed" | "none" } };
      if (!plan.sourceSave) throw new Error("expected source save metadata");
      unlinkSync(sourcePath);

      const response = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "After\n",
          baseHash: plan.sourceSave.hash,
          baseMtimeMs: plan.sourceSave.mtimeMs,
          baseEol: plan.sourceSave.eol,
          allowMissingBase: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(sourcePath, "utf-8")).toBe("After\r\n");
    } finally {
      server.stop();
    }
  });

  test("recreates a missing single-file source when the session started for that path", async () => {
    const docDir = mkdtempSync(join(tmpdir(), "plannotator-source-save-missing-start-"));
    const sourcePath = join(docDir, "source.md");

    const server = await startAnnotateServer({
      markdown: "Recovered\n",
      filePath: sourcePath,
      htmlContent: MINIMAL_HTML,
    });

    try {
      const planResponse = await fetch(`${server.url}/api/plan`);
      const plan = await planResponse.json() as {
        plan?: string;
        sourceSave?: {
          enabled?: boolean;
          path?: string;
          hash: string;
          mtimeMs: number;
          eol: "lf" | "crlf" | "mixed" | "none";
        };
      };
      expect(plan.plan).toBe("Recovered\n");
      expect(plan.sourceSave?.enabled).toBe(true);
      expect(plan.sourceSave?.path).toBe(join(realpathSync(docDir), "source.md"));

      const response = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Recovered\n",
          baseHash: plan.sourceSave!.hash,
          baseMtimeMs: plan.sourceSave!.mtimeMs,
          baseEol: plan.sourceSave!.eol,
          allowMissingBase: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(sourcePath, "utf-8")).toBe("Recovered\n");
    } finally {
      server.stop();
    }
  });

  test("verifies a saved single-file source opened through a symlink", async () => {
    const linkDir = mkdtempSync(join(tmpdir(), "plannotator-source-link-"));
    const realDir = mkdtempSync(join(tmpdir(), "plannotator-source-real-"));
    const realPath = join(realDir, "AGENTS.md");
    const linkPath = join(linkDir, "CLAUDE.md");
    writeFileSync(realPath, "Before\n", "utf-8");
    symlinkSync(realPath, linkPath);

    const server = await startAnnotateServer({
      markdown: "Before\n",
      filePath: linkPath,
      htmlContent: MINIMAL_HTML,
    });

    try {
      const planResponse = await fetch(`${server.url}/api/plan`);
      const plan = await planResponse.json() as {
        sourceSave?: {
          enabled?: boolean;
          path?: string;
          hash: string;
          mtimeMs: number;
          eol: "lf" | "crlf" | "mixed" | "none";
        };
      };
      expect(plan.sourceSave?.enabled).toBe(true);
      expect(plan.sourceSave?.path).toBe(realpathSync(realPath));

      const saveResponse = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "After\n",
          baseHash: plan.sourceSave!.hash,
          baseMtimeMs: plan.sourceSave!.mtimeMs,
          baseEol: plan.sourceSave!.eol,
          allowMissingBase: true,
        }),
      });
      expect(saveResponse.status).toBe(200);

      const probeResponse = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(plan.sourceSave!.path!)}`);
      expect(probeResponse.status).toBe(200);
      const probe = await probeResponse.json() as { markdown?: string; sourceSave?: { enabled?: boolean; path?: string } };
      expect(probe.markdown).toBe("After\n");
      expect(probe.sourceSave?.enabled).toBe(true);
      expect(probe.sourceSave?.path).toBe(realpathSync(realPath));
    } finally {
      server.stop();
    }
  });

  test("recreates a deleted folder source only after Plannotator opened it", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-source-save-"));
    const openedPath = join(folderPath, "opened.md");
    const neverOpenedPath = join(folderPath, "never-opened.md");
    writeFileSync(openedPath, "Before\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const docResponse = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(openedPath)}`);
      const doc = await docResponse.json() as { sourceSave?: { path: string; hash: string; mtimeMs: number; eol: "lf" | "crlf" | "mixed" | "none" } };
      if (!doc.sourceSave) throw new Error("expected folder source save metadata");
      unlinkSync(openedPath);

      const recreateOpened = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: doc.sourceSave.path,
          text: "After\n",
          baseHash: doc.sourceSave.hash,
          baseMtimeMs: doc.sourceSave.mtimeMs,
          baseEol: doc.sourceSave.eol,
          allowMissingBase: true,
        }),
      });

      expect(recreateOpened.status).toBe(200);
      expect(readFileSync(openedPath, "utf-8")).toBe("After\n");

      const recreateNeverOpened = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: neverOpenedPath,
          text: "Nope\n",
          baseHash: "sha256:not-a-real-opened-file",
          allowMissingBase: true,
        }),
      });

      expect(recreateNeverOpened.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("recreates a deleted folder source opened through a relative base link", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-relative-source-save-"));
    const subDir = join(folderPath, "sub");
    mkdirSync(subDir, { recursive: true });
    const linkedPath = join(folderPath, "linked.md");
    writeFileSync(join(subDir, "a.md"), "[linked](../linked.md)\n", "utf-8");
    writeFileSync(linkedPath, "Before\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const docResponse = await fetch(
        `${server.url}/api/doc?path=${encodeURIComponent("../linked.md")}&base=${encodeURIComponent(subDir)}`,
      );
      const doc = await docResponse.json() as { sourceSave?: { path: string; hash: string; mtimeMs: number; eol: "lf" | "crlf" | "mixed" | "none" } };
      if (!doc.sourceSave) throw new Error("expected folder source save metadata");
      unlinkSync(linkedPath);

      const response = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: doc.sourceSave.path,
          text: "After\n",
          baseHash: doc.sourceSave.hash,
          baseMtimeMs: doc.sourceSave.mtimeMs,
          baseEol: doc.sourceSave.eol,
          allowMissingBase: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(readFileSync(linkedPath, "utf-8")).toBe("After\n");
    } finally {
      server.stop();
    }
  });

  test("serves a folder source through the real root when the folder is symlinked", async () => {
    const realFolder = mkdtempSync(join(tmpdir(), "plannotator-folder-real-"));
    const linkParent = mkdtempSync(join(tmpdir(), "plannotator-folder-link-"));
    const linkFolder = join(linkParent, "docs");
    const realPath = join(realFolder, "note.md");
    writeFileSync(realPath, "Before\n", "utf-8");
    symlinkSync(realFolder, linkFolder);

    const server = await startAnnotateServer({
      markdown: "",
      filePath: linkFolder,
      folderPath: linkFolder,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const docResponse = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(realpathSync(realPath))}`);
      expect(docResponse.status).toBe(200);
      const doc = await docResponse.json() as { markdown?: string; sourceSave?: { enabled?: boolean; path?: string } };
      expect(doc.markdown).toBe("Before\n");
      expect(doc.sourceSave?.enabled).toBe(true);
      expect(doc.sourceSave?.path).toBe(realpathSync(realPath));
    } finally {
      server.stop();
    }
  });

  test("folder annotate doc lookup stays scoped to the selected folder", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-doc-scope-"));
    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent("package.json")}&base=${encodeURIComponent(folderPath)}`);
      expect(response.status).toBe(404);

      const existsResponse = await fetch(`${server.url}/api/doc/exists`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: ["package.json"], base: folderPath }),
      });
      expect(existsResponse.status).toBe(200);
      const existsData = await existsResponse.json() as { results?: Record<string, { status?: string }> };
      expect(existsData.results?.["package.json"]?.status).toBe("missing");
    } finally {
      server.stop();
    }
  });

  test("does not recreate a deleted folder source from draft state alone", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-draft-source-save-"));
    const deletedPath = join(realpathSync(folderPath), "deleted.md");
    const sourceSave = {
      enabled: true,
      kind: "local-text-file",
      scope: "folder-file",
      path: deletedPath,
      basename: "deleted.md",
      language: "markdown",
      hash: "sha256:draft-base",
      mtimeMs: 0,
      size: 0,
      eol: "lf",
    };

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const draftResponse = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotations: [],
          globalAttachments: [],
          editedDocuments: [{
            key: `file:${deletedPath}`,
            sourceSave,
            sessionOpenText: "",
            diskBaseline: "",
            currentText: "Recovered\n",
          }],
          ts: Date.now(),
        }),
      });
      expect(draftResponse.status).toBe(200);

      const response = await fetch(`${server.url}/api/source/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: deletedPath,
          text: "Recovered\n",
          baseHash: sourceSave.hash,
          baseEol: "lf",
          allowMissingBase: true,
        }),
      });

      expect(response.status).toBe(403);
      expect(existsSync(deletedPath)).toBe(false);
    } finally {
      await fetch(`${server.url}/api/draft`, { method: "DELETE" }).catch(() => {});
      server.stop();
    }
  });
});

describe("annotate server: folder annotate history", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;
  let savedHistoryFlag: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
    if (savedHistoryFlag === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistoryFlag;
  });

  const mintedProjects: string[] = [];
  function uniqueProject(label: string): string {
    const project = `_annotate_history_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mintedProjects.push(project);
    return project;
  }

  afterAll(() => {
    const historyDir = join(getPlannotatorDataDir(), "history");
    for (const project of mintedProjects) {
      rmSync(join(historyDir, project), { recursive: true, force: true });
    }
  });

  test("first open mints one version; reopening in the same session is memoized (no re-snapshot even if the file changes on disk)", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-first-open-"));
    const docPath = join(folderPath, "note.md");
    writeFileSync(docPath, "V1\n", "utf-8");
    const project = uniqueProject("first-open");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const first = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const firstJson = await first.json() as {
        markdown?: string;
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(firstJson.markdown).toBe("V1\n");
      expect(firstJson.previousPlan).toBeNull();
      expect(firstJson.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
      expect("diffCurrent" in firstJson).toBe(false);

      writeFileSync(docPath, "V2\n", "utf-8");

      const second = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const secondJson = await second.json() as {
        markdown?: string;
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(secondJson.markdown).toBe("V2\n");
      expect(secondJson.previousPlan).toBeNull();
      expect(secondJson.versionInfo).toEqual({ version: 1, totalVersions: 1, project });

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { versions: unknown[] };
      expect(versionsJson.versions).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("a config file is served as code and still keeps per-file version history", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-code-"));
    const docPath = join(folderPath, "config.toml");
    writeFileSync(docPath, "# Config\n[server]\nport = 8080\n", "utf-8");
    const project = uniqueProject("code");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const res = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}&doc=1`);
      const json = await res.json() as {
        renderAs?: string;
        markdown?: string;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.renderAs).toBe("code");
      expect(json.markdown).toBe("# Config\n[server]\nport = 8080\n");
      expect(json.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
    } finally {
      server.stop();
    }
  });

  test("content matching the latest stored version dedupes (mints nothing) and still serves correct previous-version fields", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-dedupe-"));
    const docPath = join(folderPath, "note.md");
    const project = uniqueProject("dedupe");

    const seedServer = await startAnnotateServer({
      markdown: "Same\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
      project,
    });
    seedServer.stop();
    writeFileSync(docPath, "Same\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const json = await response.json() as {
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
      expect(json.previousPlan).toBeNull();

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { versions: unknown[] };
      expect(versionsJson.versions).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("cross-mode slug continuity: a version saved via single-file flow is served as the baseline when a folder session opens the same path", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-cross-mode-"));
    const docPath = join(folderPath, "note.md");
    const project = uniqueProject("cross-mode");

    const seedServer = await startAnnotateServer({
      markdown: "V1\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
      project,
    });
    seedServer.stop();

    writeFileSync(docPath, "V2\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const json = await response.json() as {
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.previousPlan).toBe("V1\n");
      expect(json.versionInfo).toEqual({ version: 2, totalVersions: 2, project });

      const versionOne = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
      const versionOneJson = await versionOne.json() as { plan?: string };
      expect(versionOneJson.plan).toBe("V1\n");
    } finally {
      server.stop();
    }
  });

  test("first-ever open of a never-annotated path carries no previous version but does report version 1 of 1 (parity with single-file)", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-never-seen-"));
    const docPath = join(folderPath, "note.md");
    writeFileSync(docPath, "Fresh\n", "utf-8");
    const project = uniqueProject("never-seen");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const json = await response.json() as {
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.previousPlan).toBeNull();
      expect(json.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
      expect("diffCurrent" in json).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("config toggle off: no snapshot, no diff fields, doc still serves", async () => {
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-toggle-off-"));
    const docPath = join(folderPath, "note.md");
    writeFileSync(docPath, "Content\n", "utf-8");
    const project = uniqueProject("toggle-off");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      expect(response.status).toBe(200);
      const json = await response.json() as Record<string, unknown>;
      expect(json.markdown).toBe("Content\n");
      expect("previousPlan" in json).toBe(false);
      expect("versionInfo" in json).toBe(false);
      expect("diffCurrent" in json).toBe(false);

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { slug: string | null; versions: unknown[] };
      expect(versionsJson).toEqual({ project, slug: null, versions: [] });
    } finally {
      server.stop();
    }
  });

  test("ineligible file type (HTML) serves as today with no snapshot", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-html-"));
    const docPath = join(folderPath, "page.html");
    writeFileSync(docPath, "<html><body>Hi</body></html>", "utf-8");
    const project = uniqueProject("html");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      expect(response.status).toBe(200);
      const json = await response.json() as Record<string, unknown>;
      expect(json.renderAs).toBe("html");
      expect("previousPlan" in json).toBe(false);
      expect("versionInfo" in json).toBe(false);
      expect("diffCurrent" in json).toBe(false);

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { slug: string | null; versions: unknown[] };
      expect(versionsJson).toEqual({ project, slug: null, versions: [] });
    } finally {
      server.stop();
    }
  });

  test("eligibility matches the single-file plain-text set: .mdx mints a snapshot on first open", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-mdx-"));
    const docPath = join(folderPath, "note.mdx");
    writeFileSync(docPath, "MDX content\n", "utf-8");
    const project = uniqueProject("mdx");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const json = await response.json() as {
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.previousPlan).toBeNull();
      expect(json.versionInfo).toEqual({ version: 1, totalVersions: 1, project });
    } finally {
      server.stop();
    }
  });

  test("cross-mode continuity for config formats: a .yaml with single-file history diffs when opened via its folder", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-yaml-"));
    const docPath = join(folderPath, "config.yaml");
    const project = uniqueProject("yaml");

    const seedServer = await startAnnotateServer({
      markdown: "a: 1\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
      project,
    });
    seedServer.stop();

    writeFileSync(docPath, "a: 2\n", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}&doc=1`);
      const json = await response.json() as {
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      expect(json.previousPlan).toBe("a: 1\n");
      expect(json.versionInfo).toEqual({ version: 2, totalVersions: 2, project });
    } finally {
      server.stop();
    }
  });

  test(".env stays ineligible: no snapshot is minted even though .env.example would be", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-env-"));
    const docPath = join(folderPath, ".env");
    writeFileSync(docPath, "SECRET=1\n", "utf-8");
    const project = uniqueProject("env");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}&doc=1`);
      const json = await response.json() as Record<string, unknown>;
      expect("previousPlan" in json).toBe(false);
      expect("versionInfo" in json).toBe(false);

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { slug: string | null; versions: unknown[] };
      expect(versionsJson).toEqual({ project, slug: null, versions: [] });
    } finally {
      server.stop();
    }
  });

  test("an unwritable history directory degrades to a plain render, no error propagates", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-unwritable-"));
    const docPath = join(folderPath, "note.md");
    writeFileSync(docPath, "Content\n", "utf-8");
    const project = uniqueProject("unwritable");

    const slug = deriveAnnotateHistorySlug(docPath);
    const historyProjectDir = join(getPlannotatorDataDir(), "history", project);
    mkdirSync(historyProjectDir, { recursive: true });
    writeFileSync(join(historyProjectDir, slug), "not a directory", "utf-8");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const response = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      expect(response.status).toBe(200);
      const json = await response.json() as Record<string, unknown>;
      expect(json.markdown).toBe("Content\n");
      expect("previousPlan" in json).toBe(false);
      expect("versionInfo" in json).toBe(false);
      expect("diffCurrent" in json).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("version endpoints: path param serves that file's versions; without path, single-session binding is unchanged", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-endpoints-"));
    const docPath = join(folderPath, "note.md");
    writeFileSync(docPath, "V1\n", "utf-8");
    const project = uniqueProject("endpoints");

    const server = await startAnnotateServer({
      markdown: "",
      filePath: folderPath,
      folderPath,
      mode: "annotate-folder",
      htmlContent: MINIMAL_HTML,
      project,
    });

    try {
      const versionsBefore = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      expect(await versionsBefore.json()).toEqual({ project, slug: null, versions: [] });
      const versionBefore = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
      expect(versionBefore.status).toBe(404);
      expect(await versionBefore.json()).toEqual({ error: "No version history" });

      await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);

      const versionsAfter = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsAfterJson = await versionsAfter.json() as { slug: string | null; versions: { version: number }[] };
      expect(versionsAfterJson.slug).not.toBeNull();
      expect(versionsAfterJson.versions).toHaveLength(1);

      const versionAfter = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
      expect(versionAfter.status).toBe(200);
      expect(await versionAfter.json()).toEqual({ plan: "V1\n", version: 1 });

      const outsidePath = join(realpathSync(tmpdir()), "outside.md");
      const outsideVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`);
      expect(outsideVersions.status).toBe(200);
      expect((await outsideVersions.json()).versions).toEqual([]);
      const forwarded = { headers: { "x-forwarded-for": "100.101.102.103" } };
      const deniedVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`, forwarded);
      expect(deniedVersions.status).toBe(403);
      const deniedVersion = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(outsidePath)}&v=1`, forwarded);
      expect(deniedVersion.status).toBe(403);

      const noPathVersions = await fetch(`${server.url}/api/plan/versions`);
      expect(await noPathVersions.json()).toEqual({ project, slug: null, versions: [] });
      const noPathVersion = await fetch(`${server.url}/api/plan/version?v=1`);
      expect(noPathVersion.status).toBe(404);
    } finally {
      server.stop();
    }
  });
});

describe("annotate server: approval notes", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  test("returns the explicit approval-notes capability", async () => {
    for (const approvalNotesSupported of [true, false]) {
      const server = await startAnnotateServer({
        markdown: "# Test",
        filePath: join(tmpdir(), "approval-capability.md"),
        htmlContent: MINIMAL_HTML,
        approvalNotesSupported,
      });

      try {
        const response = await fetch(`${server.url}/api/plan`);
        const plan = await response.json() as { approvalNotesSupported?: boolean };
        expect(plan.approvalNotesSupported).toBe(approvalNotesSupported);
      } finally {
        server.stop();
      }
    }
  });

  test("preserves feedback and annotations on approval", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "approval-notes.md"),
      htmlContent: MINIMAL_HTML,
      approvalNotesSupported: true,
    });

    try {
      const response = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "Keep the retry bounded.",
          annotations: [{ id: "a1" }],
          draftGeneration: 3,
        }),
      });

      expect(response.status).toBe(200);
      expect(await server.waitForDecision()).toEqual({
        approved: true,
        feedback: "Keep the retry bounded.",
        annotations: [{ id: "a1" }],
      });
    } finally {
      server.stop();
    }
  });

  test("forwards the message scope on approval", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "approval-message-scope.md"),
      htmlContent: MINIMAL_HTML,
      approvalNotesSupported: true,
    });

    try {
      const response = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "Scope this to the picked message.",
          annotations: [],
          selectedMessageId: "message-2",
          feedbackScope: "messages",
        }),
      });

      expect(response.status).toBe(200);
      expect(await server.waitForDecision()).toEqual({
        approved: true,
        feedback: "Scope this to the picked message.",
        annotations: [],
        selectedMessageId: "message-2",
        feedbackScope: "messages",
      });
    } finally {
      server.stop();
    }
  });

  test("keeps bodyless approval compatible", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "approval-bodyless.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/approve`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await server.waitForDecision()).toEqual({
        approved: true,
        feedback: "",
        annotations: [],
      });
    } finally {
      server.stop();
    }
  });

  test("rejects malformed or wrong-type approval bodies without resolving", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "approval-invalid.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const decision = server.waitForDecision();
      const malformed = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      });
      expect(malformed.status).toBe(400);
      expect(await Promise.race([decision.then(() => "resolved"), Bun.sleep(25).then(() => "pending")])).toBe("pending");

      const wrongType = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: 42, annotations: [] }),
      });
      expect(wrongType.status).toBe(400);
      expect(await Promise.race([decision.then(() => "resolved"), Bun.sleep(25).then(() => "pending")])).toBe("pending");

      await fetch(`${server.url}/api/approve`, { method: "POST" });
      expect(await decision).toEqual({ approved: true, feedback: "", annotations: [] });
    } finally {
      server.stop();
    }
  });
});

describe("annotate server: client lease", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  async function connectClientLease(url: string): Promise<{ disconnect: () => Promise<void> }> {
    const controller = new AbortController();
    const response = await fetch(`${url}/api/annotate/client-lease`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for ready comment")), 1000);
      }),
    ]);
    expect(first.done).toBe(false);
    return {
      disconnect: async () => {
        controller.abort();
        await reader.cancel().catch(() => {});
      },
    };
  }

  function trackSettled<T>(promise: Promise<T>): () => boolean {
    let settled = false;
    promise.then(() => {
      settled = true;
    });
    return () => settled;
  }

  test("advertises the effective client-lease capability in /api/plan", async () => {
    for (const clientLeaseSupported of [true, false]) {
      const server = await startAnnotateServer({
        markdown: "# Test",
        filePath: join(tmpdir(), "client-lease-capability.md"),
        htmlContent: MINIMAL_HTML,
        gate: true,
        approvalNotesSupported: true,
        clientLeaseSupported,
      });

      try {
        const response = await fetch(`${server.url}/api/plan`);
        const plan = await response.json() as { clientLease?: { enabled: boolean; reconnectGraceMs?: number } };
        if (clientLeaseSupported) {
          expect(plan.clientLease).toEqual({ enabled: true, reconnectGraceMs: 30_000 });
        } else {
          expect(plan.clientLease).toEqual({ enabled: false });
        }
      } finally {
        server.stop();
      }
    }
  });

  test("a tailnet-published session neither advertises nor serves the lease even when the CLI predicate allowed it", async () => {
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const sandboxDataDir = mkdtempSync(join(tmpdir(), "plannotator-lease-tailnet-"));
    process.env.PLANNOTATOR_DATA_DIR = sandboxDataDir;
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-tailnet.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
      tailnetPublished: true,
    });

    try {
      const response = await fetch(`${server.url}/api/plan`);
      const plan = await response.json() as { clientLease?: { enabled: boolean } };
      expect(plan.clientLease).toEqual({ enabled: false });
      const stream = await fetch(`${server.url}/api/annotate/client-lease`);
      expect(stream.status).toBe(404);
    } finally {
      server.stop();
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(sandboxDataDir, { recursive: true, force: true });
    }
  });

  test("a tailnet-published session never offers Save to Notion, even with NOTION_TOKEN", async () => {
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const savedToken = process.env.NOTION_TOKEN;
    const sandboxDataDir = mkdtempSync(join(tmpdir(), "plannotator-notion-tailnet-"));
    process.env.PLANNOTATOR_DATA_DIR = sandboxDataDir;
    process.env.NOTION_TOKEN = "secret-token";
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "notion-tailnet.md"),
      htmlContent: MINIMAL_HTML,
      tailnetPublished: true,
    });

    try {
      const plan = await (await fetch(`${server.url}/api/plan`)).json() as { notion?: boolean };
      expect(plan.notion).toBeUndefined();
    } finally {
      server.stop();
      if (savedToken === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = savedToken;
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(sandboxDataDir, { recursive: true, force: true });
    }
  });

  test("returns 404 for the client-lease stream when the capability is disabled", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-disabled.md"),
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/annotate/client-lease`);
      expect(response.status).toBe(404);
    } finally {
      server.stop();
    }
  });

  test("resolves the decision as dismissed after the last client disconnects and the grace period elapses", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-expiry.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
      clientLeaseTestOverrides: { graceMs: 50 },
    });

    try {
      const decision = server.waitForDecision();
      const isSettled = trackSettled(decision);
      const client = await connectClientLease(server.url);

      await Bun.sleep(20);
      expect(isSettled()).toBe(false);

      await client.disconnect();

      expect(await decision).toEqual({ feedback: "", annotations: [], exit: true });
    } finally {
      server.stop();
    }
  });

  test("a reconnect before the grace deadline cancels the pending expiry", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-reconnect.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
      clientLeaseTestOverrides: { graceMs: 80 },
    });

    try {
      const decision = server.waitForDecision();
      const isSettled = trackSettled(decision);

      const firstClient = await connectClientLease(server.url);
      await firstClient.disconnect();

      await Bun.sleep(20);
      const secondClient = await connectClientLease(server.url);

      await Bun.sleep(100);
      expect(isSettled()).toBe(false);

      await secondClient.disconnect();
      expect(await decision).toEqual({ feedback: "", annotations: [], exit: true });
    } finally {
      server.stop();
    }
  });

  test("an explicit approval wins over a later client-lease expiry", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-explicit-decision.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
      clientLeaseTestOverrides: { graceMs: 60 },
    });

    try {
      const client = await connectClientLease(server.url);

      const approve = await fetch(`${server.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Looks good.", annotations: [] }),
      });
      expect(approve.status).toBe(200);
      expect(await server.waitForDecision()).toEqual({
        approved: true,
        feedback: "Looks good.",
        annotations: [],
      });

      await client.disconnect();
      await Bun.sleep(120);
      expect(await server.waitForDecision()).toEqual({
        approved: true,
        feedback: "Looks good.",
        annotations: [],
      });
    } finally {
      server.stop();
    }
  });

  test("a decision arriving after the lease expired is rejected instead of reported as applied", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-late-decision.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
      clientLeaseTestOverrides: { graceMs: 30 },
    });

    try {
      const client = await connectClientLease(server.url);
      await client.disconnect();
      expect(await server.waitForDecision()).toEqual({
        feedback: "",
        annotations: [],
        exit: true,
      });

      for (const [path, init] of [
        [
          "/api/approve",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feedback: "Looks good.", annotations: [] }),
          },
        ],
        [
          "/api/feedback",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ feedback: "Please change this.", annotations: [] }),
          },
        ],
        ["/api/exit", { method: "POST" }],
      ] as const) {
        const response = await fetch(`${server.url}${path}`, init);
        expect(response.status).toBe(409);
      }

      expect(await server.waitForDecision()).toEqual({
        feedback: "",
        annotations: [],
        exit: true,
      });
    } finally {
      server.stop();
    }
  });

  test("stopping the server ends live lease streams", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: join(tmpdir(), "client-lease-stop.md"),
      htmlContent: MINIMAL_HTML,
      gate: true,
      approvalNotesSupported: true,
      clientLeaseSupported: true,
    });

    const response = await fetch(`${server.url}/api/annotate/client-lease`);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": ready\n\n");

    server.stop();

    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});

describe("annotate server: durable submit records (#678)", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;
  let savedHistoryFlag: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "1";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
    if (savedHistoryFlag === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistoryFlag;
  });

  const mintedProjects: string[] = [];
  function uniqueProject(label: string): string {
    const project = `_annotate_submission_test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mintedProjects.push(project);
    return project;
  }

  afterAll(() => {
    const historyDir = join(getPlannotatorDataDir(), "history");
    for (const project of mintedProjects) {
      rmSync(join(historyDir, project), { recursive: true, force: true });
    }
  });

  function submissionsDir(project: string, docPath: string): string {
    return join(
      getPlannotatorDataDir(),
      "history",
      project,
      deriveAnnotateHistorySlug(resolve(docPath)),
      "submissions",
    );
  }

  async function startServer(project: string, docPath: string) {
    const markdown = `# Doc ${project}\n\nBody\n`;
    writeFileSync(docPath, markdown, "utf-8");
    return startAnnotateServer({
      markdown,
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      project,
    });
  }

  test("feedback submit writes a durable record and only then deletes the draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-durable-"));
    const docPath = join(dir, "doc.md");
    const project = uniqueProject("feedback");
    const server = await startServer(project, docPath);

    try {
      const saved = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });
      expect(saved.status).toBe(200);

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback: "## Feedback\n\nPlease fix X in the second paragraph.",
          annotations: [{ id: "a1" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      const recordDir = submissionsDir(project, docPath);
      const records = readdirSync(recordDir).filter((f) => f.endsWith(".md"));
      expect(records.length).toBe(1);
      const content = readFileSync(join(recordDir, records[0]), "utf-8");
      expect(content).toContain("Please fix X in the second paragraph.");
      expect(content).toContain("- Decision: feedback");
      expect(content).toContain(`- Source: ${resolve(docPath)}`);

      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(404);
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("approve with notes persists a record; a bare approve writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-approve-"));

    const notesDoc = join(dir, "notes.md");
    const notesProject = uniqueProject("approve-notes");
    const notesServer = await startServer(notesProject, notesDoc);
    try {
      const response = await fetch(`${notesServer.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "LGTM, but rename the helper.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      const recordDir = submissionsDir(notesProject, notesDoc);
      const records = readdirSync(recordDir).filter((f) => f.endsWith(".md"));
      expect(records.length).toBe(1);
      const content = readFileSync(join(recordDir, records[0]), "utf-8");
      expect(content).toContain("LGTM, but rename the helper.");
      expect(content).toContain("- Decision: approved (with notes)");
    } finally {
      notesServer.stop();
    }

    const bareDoc = join(dir, "bare.md");
    const bareProject = uniqueProject("approve-bare");
    const bareServer = await startServer(bareProject, bareDoc);
    try {
      const response = await fetch(`${bareServer.url}/api/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      expect(existsSync(submissionsDir(bareProject, bareDoc))).toBe(false);
    } finally {
      bareServer.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("annotateHistory disabled: no content is written and the draft is deleted (legacy behavior)", async () => {
    process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-optout-"));
    const docPath = join(dir, "doc.md");
    const project = uniqueProject("opt-out");
    const server = await startServer(project, docPath);

    try {
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Secret excerpt", annotations: [{ id: "a1" }] }),
      });
      expect(response.status).toBe(200);

      expect(existsSync(join(getPlannotatorDataDir(), "history", project))).toBe(false);
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(404);
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("previously-stateless modes stay stateless: annotate-last and URL sessions write no record", async () => {
    const lastProject = uniqueProject("last-message");
    const lastServer = await startAnnotateServer({
      markdown: `# Agent message ${lastProject}\n\nQuoted agent output.\n`,
      filePath: "last-message",
      htmlContent: MINIMAL_HTML,
      project: lastProject,
      mode: "annotate-last",
    });
    try {
      const response = await fetch(`${lastServer.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Quoting the agent: do Y instead.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(existsSync(join(getPlannotatorDataDir(), "history", lastProject))).toBe(false);
    } finally {
      lastServer.stop();
    }

    const urlProject = uniqueProject("url");
    const urlServer = await startAnnotateServer({
      markdown: `# Fetched page ${urlProject}\n\nPage content.\n`,
      filePath: "https://example.com/some/page",
      htmlContent: MINIMAL_HTML,
      project: urlProject,
    });
    try {
      const response = await fetch(`${urlServer.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "The fetched page says Z.", annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(existsSync(join(getPlannotatorDataDir(), "history", urlProject))).toBe(false);
    } finally {
      urlServer.stop();
    }
  });

  test("a malformed feedback body degrades to legacy behavior, never a 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-malformed-"));
    const docPath = join(dir, "doc.md");
    const project = uniqueProject("malformed");
    const server = await startServer(project, docPath);

    try {
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: 42, annotations: [] }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(404);
      expect(existsSync(submissionsDir(project, docPath))).toBe(false);
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed durable write keeps the draft as the recovery copy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-unwritable-"));
    const docPath = join(dir, "doc.md");
    const project = uniqueProject("unwritable");
    const historyRoot = join(getPlannotatorDataDir(), "history");
    mkdirSync(historyRoot, { recursive: true });
    writeFileSync(join(historyRoot, project), "not a directory", "utf-8");
    const server = await startServer(project, docPath);

    try {
      await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: [{ id: "a1" }] }),
      });

      const response = await fetch(`${server.url}/api/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "Please fix X", annotations: [{ id: "a1" }] }),
      });
      expect(response.status).toBe(200);

      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(200);

      await fetch(`${server.url}/api/draft`, { method: "DELETE" });
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("annotate server: live app mode (annotate-app)", () => {
  let savedPort: string | undefined;
  let savedRemote: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
  });

  afterEach(() => {
    if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
    else process.env.PLANNOTATOR_PORT = savedPort;
    if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
    else process.env.PLANNOTATOR_REMOTE = savedRemote;
  });

  function startFakeApp() {
    return Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("<html><head><title>app</title></head><body>app</body></html>", {
          headers: { "Content-Type": "text/html" },
        }),
    });
  }

  async function startLiveServer(targetUrl: string, extra?: { tailnetPublished?: boolean }) {
    return startAnnotateServer({
      markdown: "",
      filePath: targetUrl,
      htmlContent: MINIMAL_HTML,
      mode: "annotate-app",
      sourceInfo: targetUrl,
      liveApp: {
        targetUrl,
        bridgeScript: "/* bridge body */",
        bridgeBootstrap: "/* bootstrap body */",
        annotationCss: ".pn-live {}",
      },
      ...extra,
    });
  }

  test("/api/plan returns the live payload and the proxy serves the composed bridge", async () => {
    const app = startFakeApp();
    const targetUrl = `http://127.0.0.1:${app.port}`;
    const server = await startLiveServer(targetUrl);

    try {
      const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, unknown>;
      expect(plan.mode).toBe("annotate-app");
      expect(plan.filePath).toBe(targetUrl);
      expect(plan.targetUrl).toBe(targetUrl);
      expect(plan.liveToken).toMatch(/^[0-9a-f]{32}$/);
      expect(plan.sharingEnabled).toBe(false);
      expect(plan.convertHtml).toBe(false);
      expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
      expect(plan.rawHtml).toBeUndefined();
      expect(plan.renderAs).toBeUndefined();
      expect(plan.previousPlan).toBeUndefined();
      expect(plan.versionInfo).toBeUndefined();
      expect(plan.diffCurrent).toBeUndefined();
      expect((plan.agentTerminal as { enabled: boolean }).enabled).toBe(false);

      const appUrl = plan.appUrl as string;
      const bridge = await (await fetch(`${appUrl}__plannotator__/bridge.js`)).text();
      expect(bridge).toContain(String(plan.liveToken));
      const localhostAt = bridge.indexOf(`http://localhost:${server.port}`);
      const loopbackAt = bridge.indexOf(`http://127.0.0.1:${server.port}`);
      expect(localhostAt).toBeGreaterThanOrEqual(0);
      expect(loopbackAt).toBeGreaterThan(localhostAt);
      expect(bridge).toContain(".pn-live {}");
      expect(bridge.indexOf("/* bootstrap body */")).toBeLessThan(bridge.indexOf("/* bridge body */"));

      const page = await (await fetch(appUrl)).text();
      expect(page).toContain('<script src="/__plannotator__/bridge.js"></script>');
    } finally {
      server.stop();
      app.stop(true);
    }
  });

  test("a pathful target URL keeps its path and query in appUrl", async () => {
    const app = startFakeApp();
    const targetUrl = `http://127.0.0.1:${app.port}/admin/settings?tab=2`;
    const server = await startLiveServer(targetUrl);
    try {
      const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
      expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/admin\/settings\?tab=2$/);
      const res = await fetch(plan.appUrl);
      expect(res.status).toBe(200);
    } finally {
      server.stop();
      app.stop(true);
    }
  });

  test("version endpoints report no history for live sessions", async () => {
    const app = startFakeApp();
    const server = await startLiveServer(`http://127.0.0.1:${app.port}`);
    try {
      const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as {
        slug: string | null;
        versions: unknown[];
      };
      expect(versions.slug).toBeNull();
      expect(versions.versions).toEqual([]);
      const version = await fetch(`${server.url}/api/plan/version?v=1`);
      expect(version.status).toBe(404);
    } finally {
      server.stop();
      app.stop(true);
    }
  });

  test("stop() closes the proxy port with the server", async () => {
    const app = startFakeApp();
    const server = await startLiveServer(`http://127.0.0.1:${app.port}`);
    const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
    expect((await fetch(plan.appUrl)).status).toBe(200);
    server.stop();
    await Bun.sleep(50);
    let closed = false;
    try {
      await fetch(plan.appUrl, { signal: AbortSignal.timeout(1000) });
    } catch {
      closed = true;
    }
    expect(closed).toBe(true);
    app.stop(true);
  });

  describe("draft isolation between live sessions", () => {
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    let draftDataDir: string;

    beforeEach(() => {
      draftDataDir = mkdtempSync(join(tmpdir(), "plannotator-live-draft-"));
      process.env.PLANNOTATOR_DATA_DIR = draftDataDir;
    });

    afterEach(() => {
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(draftDataDir, { recursive: true, force: true });
    });

    async function saveDraft(server: { url: string }, feedback: string): Promise<void> {
      const res = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback, annotations: [] }),
      });
      expect(res.status).toBe(200);
    }

    async function loadDraft(server: { url: string }): Promise<{ feedback?: string } | null> {
      const res = await fetch(`${server.url}/api/draft`);
      if (res.status === 404) return null;
      expect(res.status).toBe(200);
      return (await res.json()) as { feedback?: string };
    }

    test("two live sessions on different targets keep independent drafts", async () => {
      const appX = startFakeApp();
      const appY = startFakeApp();
      const serverX = await startLiveServer(`http://127.0.0.1:${appX.port}`);
      const serverY = await startLiveServer(`http://127.0.0.1:${appY.port}`);
      try {
        await saveDraft(serverX, "notes for X");
        await saveDraft(serverY, "notes for Y");

        expect((await loadDraft(serverX))?.feedback).toBe("notes for X");
        expect((await loadDraft(serverY))?.feedback).toBe("notes for Y");
        expect(readdirSync(join(draftDataDir, "drafts")).length).toBe(2);
      } finally {
        serverX.stop();
        serverY.stop();
        appX.stop(true);
        appY.stop(true);
      }
    });

    test("the same target recovers its draft after a restart", async () => {
      const app = startFakeApp();
      const targetUrl = `http://127.0.0.1:${app.port}`;
      const first = await startLiveServer(targetUrl);
      try {
        await saveDraft(first, "survives the crash");
      } finally {
        first.stop();
      }
      const second = await startLiveServer(`${targetUrl}/`);
      try {
        expect((await loadDraft(second))?.feedback).toBe("survives the crash");
      } finally {
        second.stop();
        app.stop(true);
      }
    });

    test("live identities separate distinct targets and are stable across spellings", () => {
      const a = liveAppDraftIdentity("http://127.0.0.1:5173");
      expect(liveAppDraftIdentity("http://127.0.0.1:5173/")).toBe(a);
      expect(liveAppDraftIdentity("http://127.0.0.1:5174")).not.toBe(a);
      expect(liveAppDraftIdentity("http://127.0.0.1:5173/admin")).not.toBe(a);
      expect(liveAppDraftIdentity("http://127.0.0.1:5173/admin/")).toBe(
        liveAppDraftIdentity("http://127.0.0.1:5173/admin"),
      );
      expect(liveAppDraftIdentity("not a url")).toBe("not a url");
    });
  });

  test("classic file annotate still keys its draft by content", async () => {
    const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-file-draft-"));
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    const markdown = "# Doc\n\nbody text\n";
    const server = await startAnnotateServer({
      markdown,
      filePath: join(dataDir, "doc.md"),
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
    });
    try {
      const res = await fetch(`${server.url}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedback: "file note", annotations: [] }),
      });
      expect(res.status).toBe(200);
      const expectedKey = createHash("sha256").update(markdown).digest("hex").slice(0, 16);
      expect(existsSync(join(dataDir, "drafts", `${expectedKey}.json`))).toBe(true);
    } finally {
      server.stop();
      if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("remote mode rejects live app sessions outright", async () => {
    process.env.PLANNOTATOR_REMOTE = "1";
    await expect(startLiveServer("http://127.0.0.1:65500")).rejects.toThrow(
      "Live app annotation is unavailable in remote mode",
    );
  });

  test("tailnet-published sessions reject live app sessions outright", async () => {
    await expect(
      startLiveServer("http://127.0.0.1:65500", { tailnetPublished: true }),
    ).rejects.toThrow("Live app annotation is unavailable in tailnet-published sessions");
  });
});

describe("annotate server: guarded shutdown (runGuardedShutdown)", () => {
  test("a throwing disposer does not skip later steps or the listener close", () => {
    const ran: string[] = [];
    const logged: string[] = [];
    runGuardedShutdown(
      [
        ["agent terminal", () => {
          ran.push("agent terminal");
          throw new Error("pty teardown exploded");
        }],
        ["live proxy", () => ran.push("live proxy")],
      ],
      () => ran.push("listener"),
      (message) => logged.push(message),
    );
    expect(ran).toEqual(["agent terminal", "live proxy", "listener"]);
    expect(logged.some((line) => line.includes("agent terminal"))).toBe(true);
  });

  test("all steps clean: everything runs once in order, nothing is logged", () => {
    const ran: string[] = [];
    const logged: string[] = [];
    runGuardedShutdown(
      [
        ["a", () => ran.push("a")],
        ["b", () => ran.push("b")],
      ],
      () => ran.push("listener"),
      (message) => logged.push(message),
    );
    expect(ran).toEqual(["a", "b", "listener"]);
    expect(logged).toEqual([]);
  });
});
