/**
 * Pi annotate server: the file browser over its file cap. Same scenarios as
 * the Bun server (packages/server/file-browser-cap.scenarios.ts), so the
 * mirror cannot drift. One difference: Pi's file browser never had a cap, so
 * with PLANNOTATOR_FILE_BROWSER_MAX_FILES unset it lists every file (null).
 */
import { defineFileBrowserCapScenarios } from "../../../packages/server/file-browser-cap.scenarios.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

defineFileBrowserCapScenarios("pi", async (options) => {
	const server = await startAnnotateServer({
		...options,
		htmlContent: "<html><body>Plannotator</body></html>",
	});
	return { url: server.url, stop: server.stop };
}, null);
