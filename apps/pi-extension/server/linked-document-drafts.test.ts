/**
 * Pi servers: linked documents' drafts in plan review and in annotate
 * sessions without a file (#1545). Same scenarios as the Bun servers
 * (packages/server/linked-document-drafts.scenarios.ts), so the mirror cannot
 * drift. Pi's plan server serves only project files, so the Bun-only
 * plan-file allowance scenario is left out (`planFileDocuments`).
 */
import { defineLinkedDocumentDraftScenarios } from "../../../packages/server/linked-document-drafts.scenarios.ts";
import { startPlanReviewServer } from "./serverPlan.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

defineLinkedDocumentDraftScenarios("pi", {
	startPlan: async ({ plan }) => {
		const server = await startPlanReviewServer({ plan, htmlContent: MINIMAL_HTML, origin: "pi" });
		return { url: server.url, stop: server.stop, unsent: () => server.hostControl.status().unsentAnnotations };
	},
	startLastMessage: async ({ markdown }) => {
		const server = await startAnnotateServer({
			markdown,
			filePath: "last-message",
			mode: "annotate-last",
			htmlContent: MINIMAL_HTML,
		});
		return { url: server.url, stop: server.stop, unsent: () => server.hostControl.status().unsentAnnotations };
	},
	startUrl: async ({ markdown, url }) => {
		const server = await startAnnotateServer({ markdown, filePath: url, mode: "annotate", htmlContent: MINIMAL_HTML });
		return { url: server.url, stop: server.stop, unsent: () => server.hostControl.status().unsentAnnotations };
	},
});
