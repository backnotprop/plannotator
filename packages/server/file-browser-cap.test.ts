/**
 * Bun annotate server: the file browser over its file cap. The scenarios are
 * shared with the Pi mirror, see file-browser-cap.scenarios.ts.
 */
import { defineFileBrowserCapScenarios } from "./file-browser-cap.scenarios";
import { startAnnotateServer } from "./annotate";

defineFileBrowserCapScenarios("bun", async (options) => {
  const server = await startAnnotateServer({
    ...options,
    htmlContent: "<html><body>Plannotator</body></html>",
  });
  return { url: server.url, stop: server.stop };
}, 5_000);
