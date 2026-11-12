import { defineFileBrowserCapScenarios } from "./file-browser-cap.scenarios";
import { startAnnotateServer } from "./annotate";

defineFileBrowserCapScenarios("bun", async (options) => {
  const server = await startAnnotateServer({
    ...options,
    htmlContent: "<html><body>Plannotator</body></html>",
  });
  return { url: server.url, stop: server.stop };
}, 5_000);
