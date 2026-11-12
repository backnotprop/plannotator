import { defineAnnotateLiveVersionScenarios } from "../../../packages/server/annotate-live-version.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineAnnotateLiveVersionScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
});
