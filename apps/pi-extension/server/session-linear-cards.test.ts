/**
 * Pi servers: Linear hover cards behind `GET /api/ref` (`createPiRefCards` in ref-cards.ts). Same scenarios as the
 * Bun servers (packages/server/session-linear-cards.scenarios.ts), so the mirror cannot drift.
 */
import { defineSessionLinearCardsScenarios } from "../../../packages/server/session-linear-cards.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineSessionLinearCardsScenarios("pi", async (kind, { root, docPath, htmlContent, plan }) => {
	if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
	if (kind === "plan") return startPlanReviewServer({ plan, htmlContent, origin: "pi" });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
