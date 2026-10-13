/**
 * Pi annotate server: drafts follow the file. Same scenarios as the Bun
 * server (packages/server/annotate-draft.scenarios.ts), so the mirror cannot
 * drift.
 */
import { defineAnnotateDraftScenarios } from "../../../packages/server/annotate-draft.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineAnnotateDraftScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
});
