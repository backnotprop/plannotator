/**
 * Pi servers: the network key over SSH (#956). Same scenarios as the Bun
 * servers (packages/server/network-key.scenarios.ts), so the mirror cannot
 * drift. The seams are Pi's own vendored copy of the rule.
 */
import { networkKeyCookieName, resetNetworkKeysForTests, setThisMachineForTests } from "../generated/network-key.ts";
import { defineNetworkKeyScenarios } from "../../../packages/server/network-key.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startReviewServer } from "./serverReview.ts";

const PATCH = "diff --git a/notes.md b/notes.md\n--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-a\n+# Notes\n";

defineNetworkKeyScenarios(
	"pi",
	async (kind, { root, docPath, htmlContent }) => {
		if (kind === "review") return startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent, agentCwd: root });
		if (kind === "plan") return startPlanReviewServer({ plan: "# Plan\n\nSteps", htmlContent, origin: "pi" });
		return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
	},
	{ setThisMachineForTests, resetNetworkKeysForTests, networkKeyCookieName },
	// Bun's node:http emulation relays no upgrade bytes: network-key-guard.test.ts covers upgrades.
	{ upgrades: false },
);
