/**
 * Annotate Server — end-to-end route wiring
 *
 * Boots the real annotate server and exercises /api/save-notes over HTTP. This
 * is the regression guard for the original bug (#844): the route was missing
 * from the annotate server, so POSTs fell through to the SPA HTML catch-all and
 * the "Save to Obsidian" button silently failed. handleSaveNotes is unit-tested
 * in shared-handlers.test.ts; this proves it is actually wired into the server
 * and answers with JSON rather than the HTML page.
 *
 * NOTE: this can only run because apps/opencode-plugin/commands.test.ts injects
 * its annotate-server stub via CommandDeps instead of a global `mock.module`.
 * A module mock there would leak the stub into this file (Bun module mocks are
 * process-global and cannot be unset).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { startAnnotateServer } from "./annotate";
import { deriveAnnotateHistorySlug } from "@plannotator/shared/annotate-history";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

describe("annotate server: /api/save-notes wiring", () => {
  // Bind a random local port regardless of env left behind by sibling suites.
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
      // Empty body keeps this focused on wiring; handler behaviour with real
      // integrations is unit-tested in shared-handlers.test.ts. If the route
      // were missing, this POST would fall to the catch-all and return the
      // 200 text/html SPA page instead of JSON.
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

  // Regression: /api/share-html read the requested file through a lexical-only
  // containment check, so a symlinked *.html inside the doc directory pointing
  // outside it leaked the target's contents into the share payload. (Completes
  // the #927 symlink fix, which hardened the asset sinks but missed this one.)
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
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("SECRET_OUTSIDE_CONTENT");
    } finally {
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
    // Force the toggle on for every test but the one that explicitly flips it
    // off — a real ~/.plannotator/config.json on the machine running these
    // tests must never change the outcome.
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

  // Every test uses its own project namespace (history lives in the real
  // ~/.plannotator data dir, same as storage.test.ts) so runs never collide.
  // Every minted name is tracked and its history directory removed in
  // afterAll below — this suite must never leave residue in the real data
  // dir (including the stray non-directory file the "unwritable data dir"
  // test deliberately plants inside its own project's history dir; removing
  // the project dir recursively takes that with it).
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
      // diffCurrent is intentionally not propagated on the folder /api/doc
      // path — it always equals the doc's own markdown and the client never
      // reads it (unlike single-file /api/plan, which keeps it for shape parity).
      expect("diffCurrent" in firstJson).toBe(false);

      // Change the file on disk between opens — a re-run of the pipeline
      // would mint version 2. Memoization must prevent that.
      writeFileSync(docPath, "V2\n", "utf-8");

      const second = await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);
      const secondJson = await second.json() as {
        markdown?: string;
        previousPlan?: string | null;
        versionInfo?: { version: number; totalVersions: number; project: string };
      };
      // The live document content is always read fresh from disk...
      expect(secondJson.markdown).toBe("V2\n");
      // ...but the history snapshot/diff fields stay exactly what first-open computed.
      expect(secondJson.previousPlan).toBeNull();
      expect(secondJson.versionInfo).toEqual({ version: 1, totalVersions: 1, project });

      const versions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsJson = await versions.json() as { versions: unknown[] };
      expect(versionsJson.versions).toHaveLength(1);
    } finally {
      server.stop();
    }
  });

  test("content matching the latest stored version dedupes (mints nothing) and still serves correct previous-version fields", async () => {
    const folderPath = mkdtempSync(join(tmpdir(), "plannotator-folder-history-dedupe-"));
    const docPath = join(folderPath, "note.md");
    const project = uniqueProject("dedupe");

    // Seed history for this exact path via the single-file flow, then make
    // the folder file's on-disk content match that stored version exactly.
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
      // Dedup keeps it at version 1 — the folder open did not mint version 2.
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

    // Single-file session saves "V1" as version 1 for this exact resolved path.
    const seedServer = await startAnnotateServer({
      markdown: "V1\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
      project,
    });
    seedServer.stop();

    // The folder session reads different content off disk, so it mints version 2.
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
      // diffCurrent is intentionally not propagated on the folder /api/doc path.
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

    // Single-file session saves "a: 1" as version 1 for this exact path.
    const seedServer = await startAnnotateServer({
      markdown: "a: 1\n",
      filePath: docPath,
      htmlContent: MINIMAL_HTML,
      mode: "annotate",
      project,
    });
    seedServer.stop();

    // The folder session reads different content off disk, so it mints version 2.
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
      // `doc=1` mirrors the file browser: it forces annotatable plain-text
      // rendering for extensions that overlap CODE_FILE_REGEX (.yaml, .json…).
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
      // Whatever shape /api/doc answers with (.env is not annotatable, so it
      // is never served as a document), no history fields may appear and no
      // snapshot may be written.
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

    // Block the exact history directory the pipeline will try to mkdir by
    // pre-creating a plain FILE at that path — mkdirSync(recursive) throws
    // when a target segment exists and is not a directory, on every platform.
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
      // No history yet for this path: version endpoints report empty, not an error.
      const versionsBefore = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      expect(await versionsBefore.json()).toEqual({ project, slug: null, versions: [] });
      const versionBefore = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
      expect(versionBefore.status).toBe(404);
      expect(await versionBefore.json()).toEqual({ error: "No version history" });

      // Open the file so history is initialized this session.
      await fetch(`${server.url}/api/doc?path=${encodeURIComponent(docPath)}`);

      const versionsAfter = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(docPath)}`);
      const versionsAfterJson = await versionsAfter.json() as { slug: string | null; versions: { version: number }[] };
      expect(versionsAfterJson.slug).not.toBeNull();
      expect(versionsAfterJson.versions).toHaveLength(1);

      const versionAfter = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(docPath)}&v=1`);
      expect(versionAfter.status).toBe(200);
      expect(await versionAfter.json()).toEqual({ plan: "V1\n", version: 1 });

      // A path outside the folder root is rejected the same way /api/doc rejects it.
      const outsidePath = join(realpathSync(tmpdir()), "outside.md");
      const deniedVersions = await fetch(`${server.url}/api/plan/versions?path=${encodeURIComponent(outsidePath)}`);
      expect(deniedVersions.status).toBe(403);
      const deniedVersion = await fetch(`${server.url}/api/plan/version?path=${encodeURIComponent(outsidePath)}&v=1`);
      expect(deniedVersion.status).toBe(403);

      // Without a path param at all, behavior is exactly today's: this
      // session has no single-file annotateHistory binding (it's a folder
      // session), so both endpoints report "no history" as before.
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

  // Approve-with-notes must anchor exactly where Send Feedback would. Dropping
  // the message scope made the notes land on the last message rather than the
  // one the reviewer picked in a multi-message annotate-last session.
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

  /**
   * Connect to the client-lease stream and wait for its first byte (the
   * ready comment). Returns a `disconnect()` that aborts the underlying
   * fetch — plain `reader.cancel()` only stops local reads and does not
   * propagate a close to the server's `ReadableStream.cancel()`, whereas
   * aborting the request closes the connection the way an abandoned browser
   * tab actually would.
   */
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

  /**
   * Track whether a promise has settled without racing it against a timer —
   * a `Promise.race` between an already-resolved sentinel and a promise that
   * may or may not have settled is nondeterministic. Attaching `.then` up
   * front and reading a flag afterward is reliable regardless of timing.
   */
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

      // Still connected — no expiry.
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

      // Reconnect well before the 80ms grace deadline.
      await Bun.sleep(20);
      const secondClient = await connectClientLease(server.url);

      // Even past the original deadline, the reconnect cancelled the pending expiry.
      await Bun.sleep(100);
      expect(isSettled()).toBe(false);

      // A fresh disconnect starts its own full grace window.
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

      // Disconnecting after the explicit decision must not overwrite it once
      // the grace period elapses — the approval already cancelled tracking.
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

      // A tab that never saw the dismissal must not be told its decision was
      // applied: the caller already received `dismissed`.
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

    // The stream must complete rather than stay open on a server that is gone.
    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});

describe("annotate server: durable submit records (#678)", () => {
  // The decision promise's consumer (the invoking CLI/agent) can time out
  // before the reviewer submits; the submit then settled the promise with
  // nobody listening, deleted the draft, and the feedback existed nowhere.
  // These tests pin the fix: a durable record is written to
  // history/{project}/{slug}/submissions/ BEFORE the draft is deleted, the
  // annotate-history opt-out suppresses the record (stateless sessions keep
  // legacy behavior), and a failed durable write keeps the draft behind as
  // the recovery copy.
  let savedPort: string | undefined;
  let savedRemote: string | undefined;
  let savedHistoryFlag: string | undefined;

  beforeEach(() => {
    savedPort = process.env.PLANNOTATOR_PORT;
    savedRemote = process.env.PLANNOTATOR_REMOTE;
    savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
    delete process.env.PLANNOTATOR_PORT;
    process.env.PLANNOTATOR_REMOTE = "0";
    // Force the toggle on unless a test explicitly flips it off — a real
    // ~/.plannotator/config.json must never change the outcome.
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

  // History lives in the real data dir (DATA_DIR is cached at module import),
  // so each test uses a unique project namespace and afterAll removes it.
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

  // The project name is baked into the markdown so every test gets a unique
  // content-hashed draft key — drafts live in the real data dir and identical
  // markdown across tests would collide on one draft file.
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
      // Auto-saved draft exists before submit (the recovery copy).
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

      // Durable record: one markdown file next to the file's version history.
      const recordDir = submissionsDir(project, docPath);
      const records = readdirSync(recordDir).filter((f) => f.endsWith(".md"));
      expect(records.length).toBe(1);
      const content = readFileSync(join(recordDir, records[0]), "utf-8");
      expect(content).toContain("Please fix X in the second paragraph.");
      expect(content).toContain("- Decision: feedback");
      expect(content).toContain(`- Source: ${resolve(docPath)}`);

      // Draft is gone AFTER the record exists.
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(404);
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("approve with notes persists a record; a bare approve writes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-submit-approve-"));

    // Approve-with-notes carries user content -> record.
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

    // Bare approve is contentless -> nothing to persist.
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

      // The opt-out means "no annotate content in the data dir": no version
      // snapshot AND no submission record — the project dir never appears.
      expect(existsSync(join(getPlannotatorDataDir(), "history", project))).toBe(false);
      // Legacy behavior preserved: the draft is still deleted on submit.
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(404);
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("previously-stateless modes stay stateless: annotate-last and URL sessions write no record", async () => {
    // Before #678 these modes never touched the data dir; the durable record
    // must not widen the documented annotateHistory contract to them — their
    // submissions quote agent messages or fetched pages.
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
    // /api/feedback does no body type validation; pre-#678 a non-string
    // feedback flowed through settle() untouched and returned 200. The
    // durable-record guard must not turn that into a thrown 500.
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
      // Legacy behavior: draft deleted, no record (nothing persistable).
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
    // Plant a FILE where the project's history directory must go: every
    // mkdir under it fails, so both the startup snapshot and the submission
    // write degrade. (afterAll's recursive+force rm removes the file too.)
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
      // The decision itself still succeeds — persistence is an enhancement.
      expect(response.status).toBe(200);

      // But the draft survives: with no durable record written, it is the
      // only remaining copy of the reviewer's work.
      const draft = await fetch(`${server.url}/api/draft`);
      expect(draft.status).toBe(200);

      // Cleanup: don't leave this test's draft behind in the real data dir.
      await fetch(`${server.url}/api/draft`, { method: "DELETE" });
    } finally {
      server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
