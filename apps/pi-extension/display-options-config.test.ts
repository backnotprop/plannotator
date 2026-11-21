/**
 * The plan / annotate Display settings and the markdown selection mode in
 * ~/.plannotator/config.json (`displayOptions`), through the Pi (node:http) plan, review and annotate servers:
 *  - POST /api/config saves `displayOptions`, merged key by key into what
 *    config.json already holds, and refuses a value that is not a plain object
 *    with 400, saving nothing of that request;
 *  - the serverConfig of /api/plan (and /api/diff) sends it back, so a browser
 *    with no cookies (a new host, a cleared or expired cookie) gets the same look.
 * The review server takes it too: its Grid/Clean chooser writes `gridEnabled`.
 * The Bun mirror is packages/server/display-options-config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";
import { loadConfig } from "./generated/config.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-display-options-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const servers = {
  plan: { start: () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }), read: "/api/plan" },
  review: { start: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "pi" }), read: "/api/diff" },
  annotate: { start: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "pi" }), read: "/api/plan" },
};

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const serverConfig = async (url: string, read: string) =>
  ((await (await fetch(`${url}${read}`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;

describe("displayOptions on the Pi servers", () => {
  for (const [name, { start, read }] of Object.entries(servers)) {
    test(`${name}: saved to config.json, merged with what is there, and sent back in serverConfig`, async () => {
      const server = await start();
      try {
        expect((await serverConfig(server.url, read)).displayOptions).toBeUndefined();

        expect((await post(server.url, { displayOptions: { textSize: 17, inputMethod: "pinpoint" } })).status).toBe(200);
        expect((await post(server.url, { displayOptions: { showGrid: true } })).status).toBe(200);
        expect(loadConfig().displayOptions).toEqual({ textSize: 17, inputMethod: "pinpoint", showGrid: true });
        expect((await serverConfig(server.url, read)).displayOptions).toEqual({ textSize: 17, inputMethod: "pinpoint", showGrid: true });
      } finally {
        server.stop();
      }
    });

    test(`${name}: a value that is not a plain object is refused with 400 and nothing of that request is saved`, async () => {
      const server = await start();
      try {
        for (const bad of [null, "wide", 17, true, ["wide"]]) {
          const res = await post(server.url, { displayOptions: bad, displayName: "should-not-save" });
          expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
        }
        expect(loadConfig().displayOptions).toBeUndefined();
        expect(loadConfig().displayName).toBeUndefined();
      } finally {
        server.stop();
      }
    });
  }

  for (const name of (["plan", "review", "annotate"] as const)) {
    test(`${name}: a cross-origin write is refused`, async () => {
      const server = await servers[name].start();
      try {
        const forged = await fetch(`${server.url}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
          body: JSON.stringify({ displayOptions: { textSize: 21 } }),
        });
        expect(forged.status).toBe(403);
        expect(loadConfig().displayOptions).toBeUndefined();
      } finally {
        server.stop();
      }
    });
  }
});
