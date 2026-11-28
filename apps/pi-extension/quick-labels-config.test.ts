/**
 * Settings → Labels (Quick Labels) in ~/.plannotator/config.json (`quickLabels`),
 * through the Pi (node:http) plan and annotate servers (the surfaces whose
 * Settings show the Labels tab):
 *  - POST /api/config saves the array as is, replacing the previous list, and
 *    saves `null` (Reset to defaults);
 *  - the serverConfig of /api/plan sends it back, so every browser and device
 *    reviewing this machine gets the same labels and tips.
 * The Bun mirror is packages/server/quick-labels-config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer, startPlanReviewServer } from "./server.ts";
import { loadConfig } from "./generated/config.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"] as const;
const LABELS = [
  { id: "verify-this", emoji: "🔍", text: "Verify this", color: "orange", tip: "Read the code first." },
  { id: "needs-tests", emoji: "🧪", text: "Needs tests", color: "blue" },
];
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-quick-labels-config-"));
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
  plan: () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }),
  annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "pi" }),
};

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const serverConfig = async (url: string) =>
  ((await (await fetch(`${url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;

describe("quickLabels on the Pi servers", () => {
  for (const [name, start] of Object.entries(servers)) {
    test(`${name}: saved to config.json, replaced as a whole, and sent back in serverConfig`, async () => {
      const server = await start();
      try {
        expect("quickLabels" in (await serverConfig(server.url))).toBe(false);

        expect((await post(server.url, { quickLabels: LABELS })).status).toBe(200);
        expect((await post(server.url, { quickLabels: [LABELS[1]] })).status).toBe(200);
        expect(loadConfig().quickLabels).toEqual([LABELS[1]]);
        expect((await serverConfig(server.url)).quickLabels).toEqual([LABELS[1]]);
      } finally {
        server.stop();
      }
    });

    test(`${name}: Reset to defaults saves null and sends it back`, async () => {
      const server = await start();
      try {
        expect((await post(server.url, { quickLabels: LABELS })).status).toBe(200);
        expect((await post(server.url, { quickLabels: null })).status).toBe(200);
        expect(loadConfig().quickLabels).toBeNull();
        expect((await serverConfig(server.url)).quickLabels).toBeNull();
      } finally {
        server.stop();
      }
    });
  }
});
