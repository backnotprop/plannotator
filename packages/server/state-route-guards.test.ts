/**
 * Bun servers: the cross-origin and stale-tab guards on state-changing routes.
 * Scenarios are shared with the Pi mirror
 * (apps/pi-extension/server/state-route-guards.test.ts).
 */
import { defineStateRouteScenarios } from "./state-route-guards.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineStateRouteScenarios("bun", async (kind, { root, docPath, htmlContent }) => {
  if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
  if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
