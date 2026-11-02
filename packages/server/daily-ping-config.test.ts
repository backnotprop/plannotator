/**
 * The daily ping's Settings switch through the Bun servers (plan review, code
 * review, annotate; the Pi mirror is apps/pi-extension/daily-ping.test.ts):
 * POST /api/config `{ telemetry }` (boolean only, same-origin guard) writes
 * config.json, and serverConfig reports the config value plus `telemetryEnv`
 * when the environment holds the ping off, so every surface shows one switch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEMETRY_CI_VARS } from "@plannotator/shared/config";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-daily-ping-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  delete process.env.PLANNOTATOR_PORT;
  for (const key of ["DO_NOT_TRACK", "NO_ANON_PING", ...TELEMETRY_CI_VARS]) delete process.env[key];
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

describe("telemetry through POST /api/config (Bun)", () => {
  const servers = {
    plan: () => startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML }),
    review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }),
    annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }),
  };
  for (const [name, start] of Object.entries(servers)) {
    test(`${name}: the switch writes a boolean; a cross-origin write is refused`, async () => {
      const server = await start();
      try {
        expect((await post(server.url, { telemetry: false }, { Origin: "https://evil.example" })).status).toBe(403);
        expect(loadConfig().telemetry).toBeUndefined();
        await post(server.url, { telemetry: "no" });
        expect(loadConfig().telemetry).toBeUndefined();
        expect((await post(server.url, { telemetry: false })).status).toBe(200);
        expect(loadConfig().telemetry).toBe(false);
      } finally {
        server.stop();
      }
    });
  }

  test("serverConfig: the default, the saved value, and what in the environment holds it off", async () => {
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: MINIMAL_HTML });
    const config = async () => ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
    try {
      expect(await config()).toMatchObject({ telemetry: true });
      expect((await config()).telemetryEnv).toBeUndefined();
      await post(server.url, { telemetry: false });
      expect(await config()).toMatchObject({ telemetry: false });
      process.env.DO_NOT_TRACK = "1";
      expect(await config()).toMatchObject({ telemetry: false, telemetryEnv: "DO_NOT_TRACK" });
      delete process.env.DO_NOT_TRACK;
      process.env.GITHUB_ACTIONS = "true";
      expect((await config()).telemetryEnv).toBe("CI");
    } finally {
      server.stop();
    }
  });
});
