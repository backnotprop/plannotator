/**
 * Bun servers: the Host-header allowlist. Scenarios are shared with the Pi
 * mirror (request-host.scenarios.ts); the goal-setup server and the
 * `--tailscale` served-name registration are Bun-only and tested here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { normalizeGoalSetupBundle } from "@plannotator/shared/goal-setup";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { rawRequest } from "../../tests/helpers/app-html";
import { defineRequestHostScenarios } from "./request-host.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";
import { startGoalSetupServer } from "./goal-setup";
import { allowServedHostname, resetServedHostnamesForTests } from "./request-host-guard";

const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";

defineRequestHostScenarios("bun", async (kind, { docPath, htmlContent }) => {
  if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\n[notes](notes.md)", origin: "claude-code", htmlContent });
  if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n\nsecret body\n", filePath: docPath, htmlContent, mode: "annotate" });
});

describe("bun goal-setup server and tailnet names", () => {
  const environment = createTestEnvironment(
    ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER", "PLANNOTATOR_ALLOWED_HOSTS", "SSH_TTY", "SSH_CONNECTION"],
    "plannotator-request-host-bun-",
  );
  afterEach(() => {
    resetServedHostnamesForTests();
    environment.restore();
  });

  function isolate(): void {
    environment.reset();
    process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
    process.env.PLANNOTATOR_REMOTE = "0";
  }

  test("goal setup refuses a foreign Host", async () => {
    isolate();
    const server = await startGoalSetupServer({
      bundle: normalizeGoalSetupBundle({ stage: "interview", title: "Goal", questions: [{ id: "q", prompt: "Q?" }] }),
      htmlContent: "<html>goal</html>",
      origin: "claude-code",
    });
    try {
      const port = new URL(server.url).port;
      expect((await rawRequest(`${server.url}/api/plan`, { headers: { host: `localhost:${port}` } })).status).toBe(200);
      expect((await rawRequest(`${server.url}/api/plan`, { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("a --tailscale session answers the serve name it registered (tailscale serve forwards the browser's Host)", async () => {
    isolate();
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: "<html>r</html>", tailnetPublished: true });
    try {
      const port = new URL(server.url).port;
      const served = `devbox.tailnet-1234.ts.net:${port}`;
      expect((await rawRequest(`${server.url}/`, { headers: { host: served } })).status).toBe(403);
      allowServedHostname("devbox.tailnet-1234.ts.net");
      expect((await rawRequest(`${server.url}/`, { headers: { host: served } })).status).toBe(200);
      expect((await rawRequest(`${server.url}/`, { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    } finally {
      server.stop();
    }
  });
});
