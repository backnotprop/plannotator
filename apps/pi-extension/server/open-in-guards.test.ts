/**
 * Pi servers: the POST /api/open-in guards. Same scenarios as the Bun servers
 * (packages/server/open-in.scenarios.ts), so the mirror cannot drift.
 */
import { defineOpenInScenarios } from "../../../packages/server/open-in.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

const launchTest = process.platform === "win32" ? () => {} : defineOpenInScenarios;

launchTest("pi", async (kind, { root, docPath, htmlContent }) => {
	if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
	return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
