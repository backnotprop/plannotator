/**
 * Pi servers: `GET /api/ref` (the issue / PR / MR hover cards). Same scenarios
 * as the Bun servers (packages/server/ref-card-route.scenarios.ts), so the
 * mirror cannot drift. Pi has no `--tailscale`.
 */
import { defineRefCardRouteScenarios } from "../../../packages/server/ref-card-route.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineRefCardRouteScenarios("pi", async (kind, { root, docPath, htmlContent, refRunner }) => {
	if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root, refRunner });
	if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\nSee https://github.com/acme/widgets/pull/12", htmlContent, origin: "pi", refRunner });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate", refRunner });
});
