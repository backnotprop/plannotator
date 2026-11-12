import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./annotate";
import { loadConfig } from "./config";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-agent-switch-config-"));
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

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/config`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

const servers = {
  plan: { start: () => startPlannotatorServer({ plan: "# Plan", origin: "opencode", htmlContent: MINIMAL_HTML }), read: "/api/plan" },
  review: { start: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "opencode" }), read: "/api/diff" },
  annotate: { start: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "opencode" }), read: "/api/plan" },
};

describe("agentSwitch on the Bun servers", () => {
  for (const [name, { start, read }] of Object.entries(servers)) {
    const serverConfig = async (url: string) =>
      ((await (await fetch(`${url}${read}`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;

    test(`${name}: saved to config.json and sent back in serverConfig`, async () => {
      const server = await start();
      try {
        expect((await serverConfig(server.url)).agentSwitch).toBeUndefined();

        expect((await post(server.url, { agentSwitch: "disabled" }, { Origin: new URL(server.url).origin })).status).toBe(200);
        expect(loadConfig().agentSwitch).toBe("disabled");
        expect((await serverConfig(server.url)).agentSwitch).toBe("disabled");

        expect((await post(server.url, { agentSwitch: "architect" })).status).toBe(200);
        expect(loadConfig().agentSwitch).toBe("architect");

        const custom = { switchTo: "custom", customName: "reviewer" };
        expect((await post(server.url, { agentSwitch: custom })).status).toBe(200);
        expect(loadConfig().agentSwitch).toEqual(custom);
        expect((await serverConfig(server.url)).agentSwitch).toEqual(custom);
      } finally {
        server.stop();
      }
    });

    test(`${name}: an invalid value is refused with 400 and nothing of that request is saved`, async () => {
      const server = await start();
      try {
        await post(server.url, { agentSwitch: "build" });
        for (const bad of ["", " build", "line\nbreak", 42, true, null, ["build"], { switchTo: "build" }, { switchTo: "custom" }, { switchTo: "custom", customName: "" }, "x".repeat(129)]) {
          const res = await post(server.url, { agentSwitch: bad, displayName: "should-not-save" });
          expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
        }
        expect(loadConfig().agentSwitch).toBe("build");
        expect(loadConfig().displayName).toBeUndefined();
      } finally {
        server.stop();
      }
    });

    test(`${name}: a cross-origin write is refused`, async () => {
      const server = await start();
      try {
        const forged = await fetch(`${server.url}/api/config`, {
          method: "POST",
          headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
          body: JSON.stringify({ agentSwitch: "disabled" }),
        });
        expect(forged.status).toBe(403);
        expect(loadConfig().agentSwitch).toBeUndefined();
      } finally {
        server.stop();
      }
    });
  }

  test("a hand-edited value that does not parse is not advertised", async () => {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ agentSwitch: { switchTo: "build" } }));
    const server = await servers.plan.start();
    try {
      const config = ((await (await fetch(`${server.url}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
      expect("agentSwitch" in config).toBe(false);
    } finally {
      server.stop();
    }
  });
});
