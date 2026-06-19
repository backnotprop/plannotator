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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { startAnnotateServer } from "./annotate";

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
