/**
 * config.json `annotateView` (the view an annotate session opens in) through
 * the Pi (node:http) annotate server:
 *  - /api/plan's serverConfig sends a known view, and leaves a typo out;
 *  - it is config only: POST /api/config never writes it.
 * The Bun mirror is packages/server/annotate-view-config.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./server.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "PLANNOTATOR_INBOX_CONNECT", "PLANNOTATOR_UPDATE_CHECK"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-annotate-view-config-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  process.env.PLANNOTATOR_UPDATE_CHECK = "0";
  delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

const configPath = () => join(dataDir, "config.json");
const start = () =>
  startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "opencode" });
const served = async (url: string) =>
  ((await (await fetch(`${url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig.annotateView;

describe("annotateView on the Pi (node:http) annotate server", () => {
  test("a known view is served; a typo is left out", async () => {
    writeFileSync(configPath(), JSON.stringify({ annotateView: "focus" }));
    const server = await start();
    try {
      expect(await served(server.url)).toBe("focus");
      writeFileSync(configPath(), JSON.stringify({ annotateView: "Focus" }));
      expect(await served(server.url)).toBeUndefined();
    } finally {
      server.stop();
    }
  });

  test("POST /api/config never writes it", async () => {
    writeFileSync(configPath(), JSON.stringify({ annotateView: "wide" }));
    const server = await start();
    try {
      const res = await fetch(`${server.url}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: new URL(server.url).origin },
        body: JSON.stringify({ annotateView: "edit", displayName: "Reviewer" }),
      });
      expect(res.status).toBe(200);
      const file = JSON.parse(readFileSync(configPath(), "utf-8"));
      expect(file.annotateView).toBe("wide");
      expect(file.displayName).toBe("Reviewer");
    } finally {
      server.stop();
    }
  });
});
