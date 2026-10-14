/**
 * Bun servers: the POST /api/open-in guards. Scenarios are shared with the Pi
 * mirror (apps/pi-extension/server/open-in-guards.test.ts).
 */
import { defineOpenInScenarios } from "./open-in.scenarios";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

const launchTest = process.platform === "win32" ? () => {} : defineOpenInScenarios;

launchTest("bun", async (kind, { root, docPath, htmlContent }) => {
  if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
  return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
