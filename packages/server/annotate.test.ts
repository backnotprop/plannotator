/**
 * Annotate Server Route Tests
 *
 * Verifies the /api/save-notes endpoint behaves correctly.
 * Passes in CI (bun on PATH, clean env); may fail locally due to
 * PLANNOTATOR_PORT env var pollution from parallel test files.
 *
 * Run: bun test packages/server/annotate.test.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { startAnnotateServer } from "./annotate";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

describe("/api/save-notes endpoint", () => {
  test("POST saves to Obsidian vault and returns success", async () => {
    const tmpDir = mkdtempSync("/tmp/plannotator-annotate-");
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: "/tmp/test.md",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/save-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          obsidian: {
            vaultPath: tmpDir,
            folder: "plannotator",
            plan: "# Test Plan\n\nContent here",
          },
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toHaveProperty("ok", true);
      expect(json).toHaveProperty("results");
      expect(json.results.obsidian).toHaveProperty("success", true);
      expect(json.results.obsidian).toHaveProperty("path");
    } finally {
      server.stop();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("POST returns 200 with empty results when no integrations", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: "/tmp/test.md",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/save-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toHaveProperty("ok", true);
      expect(json.results).toEqual({});
    } finally {
      server.stop();
    }
  });

  test("POST with missing vault returns integration error, not server error", async () => {
    const server = await startAnnotateServer({
      markdown: "# Test",
      filePath: "/tmp/test.md",
      htmlContent: MINIMAL_HTML,
    });

    try {
      const response = await fetch(`${server.url}/api/save-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          obsidian: {
            vaultPath: "/nonexistent-vault-path",
            folder: "plannotator",
            plan: "# Test Plan\n\nContent here",
          },
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json).toHaveProperty("ok", true);
      expect(json.results.obsidian).toHaveProperty("success", false);
      expect(json.results.obsidian).toHaveProperty("error");
    } finally {
      server.stop();
    }
  });
});
