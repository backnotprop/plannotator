/**
 * Bun servers: Linear hover cards behind `GET /api/ref` (`createRefCardsWithLinear` in ref-cards.ts). Scenarios are
 * shared with the Pi mirror (apps/pi-extension/server/session-linear-cards.test.ts).
 */
import { defineSessionLinearCardsScenarios } from "./session-linear-cards.scenarios";
import { startAnnotateServer } from "./annotate";
import { startPlannotatorServer } from "./index";
import { startReviewServer } from "./review";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineSessionLinearCardsScenarios("bun", async (kind, { root, docPath, htmlContent, plan }) => {
  if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
  if (kind === "plan") return startPlannotatorServer({ plan, origin: "claude-code", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
