/**
 * Pi servers: the Host-header allowlist. Same scenarios as the Bun servers
 * (packages/server/request-host.scenarios.ts), so the mirror cannot drift.
 */
import { defineRequestHostScenarios } from "../../../packages/server/request-host.scenarios.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";

defineRequestHostScenarios("pi", async (kind, { docPath, htmlContent }) => {
	if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\n[notes](notes.md)", origin: "pi", htmlContent });
	if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent });
	return startAnnotateServer({ markdown: "# Notes\n\nsecret body\n", filePath: docPath, htmlContent, mode: "annotate" });
});
