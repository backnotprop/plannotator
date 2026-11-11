import { defineAnnotateBundleScenarios } from "./annotate-bundle.scenarios";
import { startAnnotateServer } from "./annotate";

defineAnnotateBundleScenarios("bun", async (options) => {
  const server = await startAnnotateServer({
    ...options,
    htmlContent: "<html><body>Plannotator</body></html>",
  });
  return { url: server.url, stop: server.stop };
});
