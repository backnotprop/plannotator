/**
 * Pi annotate server: several files reviewed as one. Same scenarios as the
 * Bun server (packages/server/annotate-bundle.scenarios.ts), so the mirror
 * cannot drift.
 */
import { defineAnnotateBundleScenarios } from "../../../packages/server/annotate-bundle.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineAnnotateBundleScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
});
