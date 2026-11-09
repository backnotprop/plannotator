/**
 * Bun servers: linked documents' drafts in plan review and in annotate
 * sessions without a file (#1545). The scenarios are shared with the Pi
 * mirror, see linked-document-drafts.scenarios.ts.
 */
import { defineLinkedDocumentDraftScenarios } from "./linked-document-drafts.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";

defineLinkedDocumentDraftScenarios("bun", {
  startPlan: async ({ plan, planFilePath }) => {
    const server = await startPlannotatorServer({ plan, planFilePath, htmlContent: MINIMAL_HTML, origin: "claude-code" });
    return { url: server.url, stop: () => server.stop(), unsent: () => server.hostControl.status().unsentAnnotations };
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
  planFileDocuments: true,
});
