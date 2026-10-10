/**
 * The update-notice knob through the Bun servers: Settings turns it off with
 * POST /api/config `{ updateCheck: false }` (boolean only, same-origin guard
 * as every other config write), and /api/plan's serverConfig always reports
 * the config-file value (default true) plus `updateCheckEnv` when
 * PLANNOTATOR_UPDATE_CHECK overrides it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_UPDATE_CHECK", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-check-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  delete process.env.PLANNOTATOR_PORT;
  delete process.env.PLANNOTATOR_UPDATE_CHECK;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("updateCheck through POST /api/config", () => {
  const servers = {
    plan: () => startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML }),
    review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
    annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
  };
  for (const [name, start] of Object.entries(servers)) {
    test(`${name}: the Settings switch writes a boolean; a cross-origin write is refused`, async () => {
      const server = await start();
      try {
        const forged = await post(server.url, { updateCheck: false }, { Origin: "https://evil.example" });
        expect(forged.status).toBe(403);
        expect(loadConfig().updateCheck).toBeUndefined();
        expect((await post(server.url, { updateCheck: "no" })).status).toBe(200);
        expect(loadConfig().updateCheck).toBeUndefined();
        expect((await post(server.url, { updateCheck: false })).status).toBe(200);
        expect(loadConfig().updateCheck).toBe(false);
      } finally {
        server.stop();
      }
    });
  }

  test("serverConfig: on by default, the saved value, and the env override", async () => {
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    const config = async () =>
      ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
    try {
      expect(await config()).toMatchObject({ updateCheck: true });
      expect((await config()).updateCheckEnv).toBeUndefined();
      await post(server.url, { updateCheck: false });
      expect(await config()).toMatchObject({ updateCheck: false });
      process.env.PLANNOTATOR_UPDATE_CHECK = "1";
      expect(await config()).toMatchObject({ updateCheck: false, updateCheckEnv: true });
    } finally {
      server.stop();
    }
  });
});
