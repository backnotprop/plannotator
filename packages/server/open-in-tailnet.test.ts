/**
 * A session published over the tailnet (`--tailscale`) is reachable from
 * other devices, so it never launches an app on this machine: the apps list
 * answers unavailable and POST /api/open-in is refused, as in remote mode.
 * Bun only (Pi has no --tailscale).
 *
 * No real app can launch: while a request is in flight PATH holds only a
 * scratch folder of launcher stubs that record their arguments.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";

const HTML = "<!doctype html><html><body>open-in-tailnet</body></html>";
const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

const environment = createTestEnvironment(
  [
    "PATH",
    "PLANNOTATOR_PORT",
    "PLANNOTATOR_REMOTE",
    "PLANNOTATOR_DATA_DIR",
    "PLANNOTATOR_BROWSER",
    "PLANNOTATOR_AI",
    "PLANNOTATOR_INBOX_CONNECT",
    "SSH_TTY",
    "SSH_CONNECTION",
  ],
  "plannotator-open-in-tailnet-",
);

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  environment.restore();
});

const launchTest = process.platform === "win32" ? test.skip : test;

describe("open-in in a session published over the tailnet", () => {
  for (const kind of ["annotate", "review"] as const) {
    launchTest(`${kind}: the apps list is unavailable and a launch is refused`, async () => {
      const originalPath = process.env.PATH ?? "";
      environment.reset();
      process.env.PATH = originalPath;
      const dir = environment.makeTempDir();
      process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
      process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_INBOX_CONNECT = "0";
      process.env.PLANNOTATOR_REMOTE = "0";

      const stubDir = environment.makeTempDir();
      const launchLog = join(stubDir, "launches.log");
      for (const name of ["open", "xdg-open", "code"]) {
        const stub = join(stubDir, name);
        writeFileSync(stub, `#!/bin/sh\necho "${name} $*" >> "${launchLog}"\nexit 0\n`);
        chmodSync(stub, 0o755);
      }
      const root = environment.makeTempDir();
      const docPath = join(root, "notes.md");
      writeFileSync(docPath, "# Notes\n");

      const server =
        kind === "review"
          ? await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: HTML, agentCwd: root, tailnetPublished: true })
          : await startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent: HTML, mode: "annotate", tailnetPublished: true });
      stop = () => server.stop();

      process.env.PATH = stubDir;
      try {
        const apps = await fetch(`${server.url}/api/open-in/apps`);
        expect(await apps.json()).toEqual({ available: false, apps: [] });

        const launch = await fetch(`${server.url}/api/open-in`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filePath: docPath, appId: "reveal" }),
        });
        expect(launch.status).toBe(400);
        expect(((await launch.json()) as { ok?: boolean }).ok).toBe(false);
      } finally {
        process.env.PATH = originalPath;
      }
      expect(existsSync(launchLog) ? readFileSync(launchLog, "utf8") : "").toBe("");
    });
  }
});
