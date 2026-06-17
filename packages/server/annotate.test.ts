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
