/**
 * Pi servers: the cross-origin and stale-tab guards on state-changing routes.
 * Same scenarios as the Bun servers
 * (packages/server/state-route-guards.scenarios.ts), so the mirror cannot drift.
 */
import { defineStateRouteScenarios } from "../../../packages/server/state-route-guards.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineStateRouteScenarios("pi", async (kind, { root, docPath, htmlContent }) => {
	if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
	if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\nSteps", htmlContent, origin: "pi" });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
