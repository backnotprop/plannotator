/**
 * Bun plan and annotate servers: who may list and read through the Files
 * sidebar and Obsidian routes. Scenarios are shared with the Pi mirror
 * (apps/pi-extension/server/reference-readers.test.ts).
 */
import { defineReferenceReaderScenarios } from "./reference-readers.scenarios";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";

defineReferenceReaderScenarios("bun", async (kind, { docPath, htmlContent }) => {
  if (kind === "plan") return startPlannotatorServer({ plan: "# Plan\n\nSteps", origin: "claude-code", htmlContent });
  return startAnnotateServer({ markdown: "# Notes\n", filePath: docPath, htmlContent, mode: "annotate" });
});
